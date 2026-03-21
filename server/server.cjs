const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Root route to confirm server status
app.get('/', (req, res) => {
    res.send('Tracker v2 API Server is running.');
});

// Helper to extract YouTube video ID from various URL formats
function extractVideoId(input) {
    if (!input) return null;
    input = input.trim();

    // Direct 11-char video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

    try {
        const url = new URL(input);
        const hostname = url.hostname.replace('www.', '');

        // youtube.com/watch?v=ID (v= can be anywhere in params)
        if (hostname === 'youtube.com' || hostname === 'music.youtube.com' || hostname === 'm.youtube.com') {
            const v = url.searchParams.get('v');
            if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

            // youtube.com/embed/ID or youtube.com/v/ID or youtube.com/shorts/ID or youtube.com/live/ID
            const pathMatch = url.pathname.match(/\/(embed|v|shorts|live)\/([a-zA-Z0-9_-]{11})/);
            if (pathMatch) return pathMatch[2];
        }

        // youtu.be/ID
        if (hostname === 'youtu.be') {
            const id = url.pathname.slice(1).split('/')[0].split('?')[0];
            if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
        }
    } catch (e) {
        // Not a valid URL, try regex fallback
    }

    // Regex fallback for malformed URLs
    const fallback = input.match(/(?:v=|\/|^)([a-zA-Z0-9_-]{11})(?:[&?\s]|$)/);
    if (fallback) return fallback[1];

    return null;
}

// Downloads directory - inside public/ so Vite serves it as static files
const DOWNLOADS_DIR = path.join(__dirname, '..', 'public', 'downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Clean old downloads on startup
try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    for (const file of files) {
        fs.unlinkSync(path.join(DOWNLOADS_DIR, file));
    }
    console.log(`Cleaned ${files.length} old download(s)`);
} catch (e) { /* ignore */ }

// Video download endpoint - saves to public/downloads/ and returns static URL
app.get('/api/download', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing YouTube URL' });
    }

    try {
        const videoId = extractVideoId(url);
        const youtubeUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
        console.log(`Download request - raw url: ${url}, parsed id: ${videoId}, final url: ${youtubeUrl}`);

        // Check for cookies file
        const cookiesFile = path.join(__dirname, '..', 'www.youtube.com_cookies.txt');
        const hasCookiesFile = fs.existsSync(cookiesFile);

        let cookiesArg = '--cookies-from-browser chrome';
        if (hasCookiesFile) {
            console.log('Using cookies.txt file for authentication');
            cookiesArg = `--cookies "${cookiesFile}"`;
        } else {
            console.log('Using Chrome browser cookies for authentication');
        }

        const uaArgs = '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --referer "https://www.youtube.com/"';

        // Create output file in public/downloads/
        const filename = `${videoId || 'video'}_${Date.now()}.mp4`;
        const outputFile = path.join(DOWNLOADS_DIR, filename);

        // Download using global yt-dlp directly to public/downloads/
        console.log('Downloading to:', outputFile);
        const downloadCmd = `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 ${cookiesArg} ${uaArgs} -o "${outputFile}" "${youtubeUrl}"`;
        console.log('Running:', downloadCmd);

        execSync(downloadCmd, {
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024,
            timeout: 300000 // 5 minute timeout
        });

        if (!fs.existsSync(outputFile)) {
            throw new Error('Downloaded file not found at: ' + outputFile);
        }

        const stat = fs.statSync(outputFile);
        console.log(`Download complete: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

        // Return JSON with the static file URL that Vite will serve
        res.json({
            success: true,
            url: `/downloads/${filename}`,
            size: stat.size,
            filename: filename
        });

    } catch (error) {
        console.error('Download error:', error.message || error);
        if (error.stderr) {
            console.error('yt-dlp stderr:', error.stderr);
        }
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'Failed to download video' });
        }
    }
});

// Video info endpoint
app.get('/api/video-info', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing YouTube URL' });
    }

    const videoId = extractVideoId(url);
    const youtubeUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
    console.log(`Video info request - raw url: ${url}, parsed id: ${videoId}, final url: ${youtubeUrl}`);

    try {
        const cookiesFile = path.join(__dirname, '..', 'www.youtube.com_cookies.txt');
        const hasCookiesFile = fs.existsSync(cookiesFile);

        let cookiesArg = '--cookies-from-browser chrome';
        if (hasCookiesFile) {
            cookiesArg = `--cookies "${cookiesFile}"`;
        }

        const cmd = `yt-dlp --dump-single-json --no-warnings ${cookiesArg} "${youtubeUrl}"`;
        console.log('Fetching video info:', cmd);

        const infoJson = execSync(cmd, {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30000 // 30 second timeout
        });
        const info = JSON.parse(infoJson);

        res.json({
            id: videoId,
            title: info.title || 'Unknown Title',
            channel: info.channel || info.uploader || 'Unknown Channel',
            thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            duration: info.duration || 0,
            description: info.description || ''
        });
    } catch (error) {
        console.error('Video info error:', error.message);
        res.json({
            id: videoId,
            title: 'Video ' + videoId,
            channel: 'Unknown',
            thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            duration: 0
        });
    }
});

// Helper to validate Netscape cookie format
function isValidCookieFormat(content) {
    return content.includes('TRUE') || content.includes('FALSE') || content.includes('.youtube.com');
}

// Endpoint to update cookies.txt
app.post('/api/update-cookies', (req, res) => {
    try {
        const { content } = req.body;
        if (!content || typeof content !== 'string') {
            return res.status(400).json({ error: 'Missing cookie content' });
        }

        if (!isValidCookieFormat(content)) {
            return res.status(400).json({ error: 'Invalid cookie file format. Must be Netscape HTTP Cookie File.' });
        }

        const cookiesFile = path.join(__dirname, '..', 'www.youtube.com_cookies.txt');
        fs.writeFileSync(cookiesFile, content, 'utf8');

        console.log('Cookies file updated via API');
        res.json({ success: true, message: 'Cookies updated successfully' });
    } catch (error) {
        console.error('Update cookies error:', error);
        res.status(500).json({ error: 'Failed to save cookies file' });
    }
});

async function startServer() {
    const server = await app.listen(PORT);
    console.log(`Tracker v2 API Server running at http://localhost:${PORT}`);
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
