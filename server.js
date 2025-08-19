const express = require('express');
const ytdl = require('ytdl-core');
const ytsr = require('ytsr');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// Create downloads directory
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Store for completed downloads
let completedDownloads = [];
let currentDownload = null;

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Search endpoint
app.post('/search', async (req, res) => {
    try {
        const { query } = req.body;
        
        if (!query) {
            return res.status(400).json({
                status: 'error',
                message: 'No query provided!'
            });
        }

        console.log(`Searching for: ${query}`);
        
        // Check if it's a direct YouTube URL
        if (ytdl.validateURL(query)) {
            try {
                const info = await ytdl.getInfo(query);
                const video = {
                    title: info.videoDetails.title,
                    url: query,
                    thumbnail: info.videoDetails.thumbnails && info.videoDetails.thumbnails.length > 0 
                        ? info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url
                        : 'https://via.placeholder.com/320x180?text=No+Thumbnail',
                    duration: info.videoDetails.lengthSeconds,
                    views: info.videoDetails.viewCount
                };
                
                return res.json({
                    status: 'success',
                    results: [video]
                });
            } catch (error) {
                console.error('Error getting video info:', error);
                return res.status(500).json({
                    status: 'error',
                    message: 'Invalid YouTube URL or video not accessible'
                });
            }
        }

        // Search YouTube
        try {
            const searchResults = await ytsr(query, { limit: 20 });
            
            const videos = searchResults.items
                .filter(item => item.type === 'video' && item.url)
                .slice(0, 12)
                .map(video => ({
                    title: video.title || 'Unknown Title',
                    url: video.url,
                    thumbnail: video.bestThumbnail?.url || 
                              (video.thumbnails && video.thumbnails.length > 0 ? video.thumbnails[0].url : '') ||
                              'https://via.placeholder.com/320x180?text=No+Thumbnail',
                    duration: video.duration || 'Unknown',
                    views: video.views || 0
                }));

            res.json({
                status: 'success',
                results: videos
            });
        } catch (searchError) {
            console.error('Search error:', searchError);
            res.status(500).json({
                status: 'error',
                message: 'Search failed. YouTube might be blocking requests. Please try again later.'
            });
        }

    } catch (error) {
        console.error('General search error:', error);
        res.status(500).json({
            status: 'error',
            message: 'Search failed. Please try again.'
        });
    }
});

// Download endpoint
app.post('/download', async (req, res) => {
    try {
        const { url, format } = req.body;
        
        if (!url) {
            return res.status(400).json({
                status: 'error',
                message: 'No URL provided!'
            });
        }

        if (!ytdl.validateURL(url)) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid YouTube URL!'
            });
        }

        // Check if video is available
        try {
            const info = await ytdl.getInfo(url);
            if (!info) {
                throw new Error('Video not found');
            }
        } catch (error) {
            return res.status(400).json({
                status: 'error',
                message: 'Video not available or restricted'
            });
        }

        // Start download process
        downloadVideo(url, format || 'video');
        
        res.json({
            status: 'success',
            message: 'Download started!'
        });

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({
            status: 'error',
            message: 'Download failed. Please try again.'
        });
    }
});

// Check completed downloads
app.get('/check-completed', (req, res) => {
    if (currentDownload && currentDownload.completed) {
        const download = currentDownload;
        currentDownload = null; // Clear after sending
        
        res.json({
            status: 'finished',
            filename: download.filename,
            path: `/download/${download.filename}`
        });
    } else {
        res.json({
            status: 'pending'
        });
    }
});

// Serve download files
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(downloadsDir, filename);
    
    if (fs.existsSync(filePath)) {
        // Set proper headers for download
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
        
        fileStream.on('error', (err) => {
            console.error('File stream error:', err);
            res.status(500).send('Error downloading file');
        });
    } else {
        res.status(404).send('File not found');
    }
});

// Download function
async function downloadVideo(url, format) {
    try {
        console.log(`Starting download: ${url}, format: ${format}`);
        
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 100); // Limit filename length
        
        let filename;
        let downloadOptions;
        
        if (format === 'audio') {
            filename = `${title}.mp3`;
            downloadOptions = {
                filter: 'audioonly',
                quality: 'highestaudio',
                format: 'mp3'
            };
        } else {
            filename = `${title}.mp4`;
            downloadOptions = {
                filter: format => format.container === 'mp4' && format.hasVideo && format.hasAudio,
                quality: 'highest'
            };
        }
        
        const filePath = path.join(downloadsDir, filename);
        
        // Set current download status
        currentDownload = {
            filename: filename,
            title: title,
            completed: false,
            progress: 0
        };
        
        console.log(`Downloading to: ${filePath}`);
        
        const stream = ytdl(url, downloadOptions);
        const writeStream = fs.createWriteStream(filePath);
        
        stream.pipe(writeStream);
        
        stream.on('progress', (chunkLength, downloaded, total) => {
            const percent = downloaded / total;
            if (currentDownload) {
                currentDownload.progress = Math.round(percent * 100);
            }
            console.log(`Download progress: ${Math.round(percent * 100)}%`);
        });
        
        writeStream.on('finish', () => {
            console.log(`Download completed: ${filename}`);
            if (currentDownload) {
                currentDownload.completed = true;
                currentDownload.progress = 100;
            }
        });
        
        writeStream.on('error', (error) => {
            console.error('Write stream error:', error);
            if (currentDownload) {
                currentDownload.error = error.message;
            }
        });
        
        stream.on('error', (error) => {
            console.error('Download stream error:', error);
            if (currentDownload) {
                currentDownload.error = error.message;
            }
        });
        
    } catch (error) {
        console.error('Download function error:', error);
        if (currentDownload) {
            currentDownload.error = error.message;
        }
    }
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({
        status: 'error',
        message: 'Internal server error'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 YouTube Downloader Server running on port ${PORT}`);
    console.log(`📱 Access the app at: http://localhost:${PORT}`);
    console.log(`📁 Downloads will be saved to: ${downloadsDir}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    process.exit(0);
});