const express = require('express');
const ytdl = require('@distube/ytdl-core');
const YouTube = require('youtube-sr').default;
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const sanitize = require('sanitize-filename');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow inline scripts for video player
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/search', limiter);
app.use('/download', limiter);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('.'));

// Create downloads directory
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Store for downloads and streaming
let activeDownloads = new Map();
let completedDownloads = new Map();

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Get video info for streaming
app.get('/video-info/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid video ID'
            });
        }

        const info = await ytdl.getInfo(url);
        const formats = ytdl.filterFormats(info.formats, 'videoandaudio');
        
        res.json({
            status: 'success',
            title: info.videoDetails.title,
            duration: info.videoDetails.lengthSeconds,
            thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url,
            formats: formats.map(format => ({
                itag: format.itag,
                quality: format.qualityLabel || format.quality,
                container: format.container,
                hasVideo: format.hasVideo,
                hasAudio: format.hasAudio
            }))
        });
    } catch (error) {
        console.error('Video info error:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to get video information'
        });
    }
});

// Stream video directly
app.get('/stream/:videoId', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        const quality = req.query.quality || 'highest';
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        
        if (!ytdl.validateURL(url)) {
            return res.status(400).send('Invalid video ID');
        }

        const range = req.headers.range;
        
        if (range) {
            const info = await ytdl.getInfo(url);
            const format = ytdl.chooseFormat(info.formats, { quality: quality });
            
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Accept-Ranges', 'bytes');
            
            const videoStream = ytdl(url, { 
                quality: quality,
                range: range 
            });
            
            videoStream.pipe(res);
            
            videoStream.on('error', (err) => {
                console.error('Stream error:', err);
                res.status(500).end();
            });
        } else {
            res.setHeader('Content-Type', 'video/mp4');
            const videoStream = ytdl(url, { quality: quality });
            videoStream.pipe(res);
        }
        
    } catch (error) {
        console.error('Streaming error:', error);
        res.status(500).send('Streaming failed');
    }
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
                const videoId = info.videoDetails.videoId;
                const video = {
                    id: videoId,
                    title: info.videoDetails.title,
                    url: query,
                    thumbnail: info.videoDetails.thumbnails && info.videoDetails.thumbnails.length > 0 
                        ? info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url
                        : 'https://via.placeholder.com/320x180?text=No+Thumbnail',
                    duration: info.videoDetails.lengthSeconds,
                    views: info.videoDetails.viewCount,
                    author: info.videoDetails.author.name
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
            const searchResults = await YouTube.search(query, { limit: 12, type: 'video' });
            const videos = searchResults.map(video => ({
                id: video.id,
                title: video.title,
                url: video.url,
                thumbnail: video.thumbnail?.displayThumbnailURL('maxresdefault') || 'https://via.placeholder.com/320x180?text=No+Thumbnail',
                duration: video.durationFormatted,
                views: video.views,
                author: video.channel?.name || 'Unknown'
            }));

            res.json({
                status: 'success',
                results: videos
            });
        } catch (searchError) {
            console.error('Search error:', searchError);
            res.status(500).json({
                status: 'error',
                message: 'Search failed. Please try again later.'
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

        // Get video info first
        const info = await ytdl.getInfo(url);
        const videoId = info.videoDetails.videoId;
        
        // Check if already downloading
        if (activeDownloads.has(videoId)) {
            return res.json({
                status: 'success',
                message: 'Download already in progress',
                downloadId: videoId
            });
        }

        // Start download
        const downloadId = await startDownload(url, format || 'video', info);
        
        res.json({
            status: 'success',
            message: 'Download started!',
            downloadId: downloadId
        });

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({
            status: 'error',
            message: error.message || 'Download failed. Please try again.'
        });
    }
});

// Check download progress
app.get('/download-progress/:downloadId', (req, res) => {
    const downloadId = req.params.downloadId;
    const download = activeDownloads.get(downloadId) || completedDownloads.get(downloadId);
    
    if (!download) {
        return res.status(404).json({
            status: 'error',
            message: 'Download not found'
        });
    }
    
    res.json({
        status: download.completed ? 'completed' : 'downloading',
        progress: download.progress,
        filename: download.filename,
        downloadPath: download.completed ? `/download/${download.filename}` : null,
        error: download.error
    });
});

// Check completed downloads (legacy endpoint)
app.get('/check-completed', (req, res) => {
    // Return the first completed download
    for (let [id, download] of completedDownloads.entries()) {
        if (download.completed && !download.sent) {
            download.sent = true;
            return res.json({
                status: 'finished',
                filename: download.filename,
                path: `/download/${download.filename}`
            });
        }
    }
    
    res.json({
        status: 'pending'
    });
});

// Serve download files
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(downloadsDir, filename);
    
    if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${filename}"`
            };
            res.writeHead(200, head);
            fs.createReadStream(filePath).pipe(res);
        }
    } else {
        res.status(404).send('File not found');
    }
});

// Download function
async function startDownload(url, format, info) {
    const videoId = info.videoDetails.videoId;
    const title = sanitize(info.videoDetails.title.substring(0, 100));
    
    let filename;
    let downloadOptions;
    
    if (format === 'audio') {
        filename = `${title}.mp3`;
        downloadOptions = {
            filter: 'audioonly',
            quality: 'highestaudio'
        };
    } else {
        filename = `${title}.mp4`;
        downloadOptions = {
            filter: 'videoandaudio',
            quality: 'highest'
        };
    }
    
    const filePath = path.join(downloadsDir, filename);
    
    // Create download entry
    const downloadInfo = {
        id: videoId,
        filename: filename,
        title: title,
        progress: 0,
        completed: false,
        error: null,
        filePath: filePath
    };
    
    activeDownloads.set(videoId, downloadInfo);
    
    try {
        console.log(`Starting download: ${title}`);
        
        const stream = ytdl(url, downloadOptions);
        const writeStream = fs.createWriteStream(filePath);
        
        let downloadedBytes = 0;
        let totalBytes = 0;
        
        stream.on('response', (response) => {
            totalBytes = parseInt(response.headers['content-length']) || 0;
        });
        
        stream.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0) {
                const progress = Math.round((downloadedBytes / totalBytes) * 100);
                downloadInfo.progress = progress;
            }
        });
        
        stream.on('progress', (chunkLength, downloaded, total) => {
            const progress = Math.round((downloaded / total) * 100);
            downloadInfo.progress = progress;
            console.log(`Download progress for ${title}: ${progress}%`);
        });
        
        stream.pipe(writeStream);
        
        writeStream.on('finish', () => {
            console.log(`Download completed: ${filename}`);
            downloadInfo.completed = true;
            downloadInfo.progress = 100;
            
            // Move to completed downloads
            activeDownloads.delete(videoId);
            completedDownloads.set(videoId, downloadInfo);
        });
        
        writeStream.on('error', (error) => {
            console.error('Write stream error:', error);
            downloadInfo.error = error.message;
            activeDownloads.delete(videoId);
        });
        
        stream.on('error', (error) => {
            console.error('Download stream error:', error);
            downloadInfo.error = error.message;
            activeDownloads.delete(videoId);
        });
        
    } catch (error) {
        console.error('Download function error:', error);
        downloadInfo.error = error.message;
        activeDownloads.delete(videoId);
    }
    
    return videoId;
}

// Clean up old downloads periodically
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    for (let [id, download] of completedDownloads.entries()) {
        if (now - download.timestamp > maxAge) {
            // Delete file and remove from memory
            if (fs.existsSync(download.filePath)) {
                fs.unlinkSync(download.filePath);
            }
            completedDownloads.delete(id);
        }
    }
}, 60 * 60 * 1000); // Run every hour

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