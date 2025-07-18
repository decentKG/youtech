const express = require('express');
const ytdl = require('ytdl-core');
const ytsr = require('ytsr');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Create downloads directory
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Store for completed downloads
const completedDownloads = new Map();

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
                    thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url
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
        const searchResults = await ytsr(query, { limit: 20 });
        
        const videos = searchResults.items
            .filter(item => item.type === 'video')
            .slice(0, 12)
            .map(video => ({
                title: video.title,
                url: video.url,
                thumbnail: video.bestThumbnail?.url || video.thumbnails?.[0]?.url || ''
            }));

        res.json({
            status: 'success',
            results: videos
        });

    } catch (error) {
        console.error('Search error:', error);
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
    const lastDownload = completedDownloads.get('last');
    
    if (lastDownload) {
        res.json({
            status: 'finished',
            filename: lastDownload.filename,
            path: `/download/${lastDownload.filename}`
        });
        
        // Clear the completed download after sending
        completedDownloads.delete('last');
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
        res.download(filePath, filename, (err) => {
            if (err) {
                console.error('Download error:', err);
                res.status(500).send('Error downloading file');
            }
        });
    } else {
        res.status(404).send('File not found');
    }
});

// Download function
async function downloadVideo(url, format) {
    try {
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title.replace(/[^\w\s-]/g, '').trim();
        
        let filename;
        let stream;
        
        if (format === 'audio') {
            filename = `${title}.mp3`;
            stream = ytdl(url, {
                filter: 'audioonly',
                quality: 'highestaudio'
            });
        } else {
            filename = `${title}.mp4`;
            stream = ytdl(url, {
                filter: 'videoandaudio',
                quality: 'highest'
            });
        }
        
        const filePath = path.join(downloadsDir, filename);
        const writeStream = fs.createWriteStream(filePath);
        
        stream.pipe(writeStream);
        
        writeStream.on('finish', () => {
            console.log(`Download completed: ${filename}`);
            completedDownloads.set('last', {
                filename: filename,
                title: title
            });
        });
        
        writeStream.on('error', (error) => {
            console.error('Write stream error:', error);
        });
        
        stream.on('error', (error) => {
            console.error('Download stream error:', error);
        });
        
    } catch (error) {
        console.error('Download function error:', error);
    }
}

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access the app at: http://localhost:${PORT}`);
});