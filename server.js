import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import FormData from 'form-data';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Configuration
const CONFIG = {
  STREAM_API_KEYS: [
    'df9c7330b4c1807041d5d386',
    '1042fc7f00df7e878f3ca270',
    '79d324569b3e0f16a11bb79c',
    '74f596a5c7f2c16747eba33c',
    '757245d8037f14775b9cfef8',
    '82f9520d915e75bbe1df1c93'
  ],
  TMDB_API_KEY: 'b85ea590b2ffd2a8d04e068fc069001e',
  DASHBOARD_PASSWORD: 'Alien101',
  STREAM_API_BASE: 'https://streamp2p.com/api/v1/video/manage',
  STREAM_UPLOAD_BASE: 'https://streamp2p.com/api/v1/video',
  TMDB_BASE_URL: 'https://api.themoviedb.org/3'
};

const DATA_FILE = path.join(__dirname, 'requests.json');
const LOG_FILE = path.join(__dirname, 'server.log');

// Global state
let currentKeyIndex = 0;
let ipTracker = {};
let renameProgress = { running: false, current: 0, total: 0, status: '', failures: [] };
let uploadProgress = { running: false, current: 0, total: 0, status: '', uploads: [] };
let duplicateProgress = { running: false, current: 0, total: 0, status: '', duplicates: [] };

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10GB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v)$/i;
    cb(null, allowedTypes.test(file.originalname));
  }
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Utilities
const getApiKey = () => {
  const key = CONFIG.STREAM_API_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % CONFIG.STREAM_API_KEYS.length;
  return key;
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const log = (message, level = 'INFO') => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${level}: ${message}`;
  console.log(logMessage);
  fs.appendFileSync(LOG_FILE, logMessage + '\n');
};

const readData = () => {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, '[]');
      return [];
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    log(`Error reading data file: ${error.message}`, 'ERROR');
    return [];
  }
};

const writeData = (data) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    log(`Error writing data file: ${error.message}`, 'ERROR');
  }
};

// Normalization for exact matching (strips all special chars)
const normalize = (str) => str?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';

// NEW: Normalization for title matching (keeps spaces)
const normalizeTitle = (str) => str?.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim() || '';

// Enhanced episode extraction
const extractSeasonEpisode = (name = '') => {
  const patterns = [
    /s(\d{1,2})[.\-_\s]?e(\d{1,2})/i,
    /season[\s\-_]*(\d{1,2})[\s\-_]*episode[\s\-_]*(\d{1,2})/i,
    /(\d{1,2})x(\d{1,2})/i
  ];

  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) {
      return {
        season: parseInt(match[1]),
        episode: parseInt(match[2])
      };
    }
  }
  return { season: null, episode: null };
};

// Enhanced TMDB series info fetching
const getTMDBSeriesInfo = async (seriesId) => {
  try {
    const response = await axios.get(`${CONFIG.TMDB_BASE_URL}/tv/${seriesId}`, {
      params: { api_key: CONFIG.TMDB_API_KEY }
    });
    
    const series = response.data;
    const seasonInfo = {};
    
    for (const season of series.seasons) {
      if (season.season_number > 0) { // Skip specials
        seasonInfo[season.season_number] = {
          episodeCount: season.episode_count,
          name: season.name,
          airDate: season.air_date
        };
      }
    }
    
    return {
      name: series.name,
      totalSeasons: series.number_of_seasons,
      totalEpisodes: series.number_of_episodes,
      seasons: seasonInfo
    };
  } catch (error) {
    log(`Error fetching TMDB series info: ${error.message}`, 'ERROR');
    return null;
  }
};

// Extract TMDB ID from filename
const extractTMDBId = (filename) => {
  const match = filename.match(/\{(\d+)\}/);
  return match ? match[1] : null;
};

// Organize series episodes
const organizeSeriesEpisodes = (videos) => {
  const organized = {};
  
  videos.forEach(video => {
    const { season, episode } = extractSeasonEpisode(video.name);
    const tmdbId = extractTMDBId(video.name);
    
    if (season && episode && tmdbId) {
      if (!organized[tmdbId]) {
        organized[tmdbId] = {
          seriesName: video.name.split('S')[0].trim().replace(/\{.*?\}/g, '').trim(),
          tmdbId: tmdbId,
          seasons: {}
        };
      }
      
      if (!organized[tmdbId].seasons[season]) {
        organized[tmdbId].seasons[season] = {};
      }
      
      organized[tmdbId].seasons[season][episode] = video;
    }
  });
  
  return organized;
};

// Check for missing episodes
const checkMissingEpisodes = async (organizedSeries) => {
  const results = {};
  
  for (const [tmdbId, seriesData] of Object.entries(organizedSeries)) {
    const tmdbInfo = await getTMDBSeriesInfo(tmdbId);
    if (!tmdbInfo) continue;
    
    results[tmdbId] = {
      seriesName: seriesData.seriesName,
      tmdbId: tmdbId,
      seasons: {},
      summary: {
        totalSeasons: tmdbInfo.totalSeasons,
        seasonsAvailable: Object.keys(seriesData.seasons).length,
        missingSeasons: []
      }
    };
    
    // Check each season
    for (let seasonNum = 1; seasonNum <= tmdbInfo.totalSeasons; seasonNum++) {
      const expectedEpisodes = tmdbInfo.seasons[seasonNum]?.episodeCount || 0;
      const availableEpisodes = seriesData.seasons[seasonNum] || {};
      const availableCount = Object.keys(availableEpisodes).length;
      
      if (availableCount === 0) {
        results[tmdbId].summary.missingSeasons.push(seasonNum);
      }
      
      const missingEpisodes = [];
      for (let ep = 1; ep <= expectedEpisodes; ep++) {
        if (!availableEpisodes[ep]) {
          missingEpisodes.push(ep);
        }
      }
      
      results[tmdbId].seasons[seasonNum] = {
        name: tmdbInfo.seasons[seasonNum]?.name || `Season ${seasonNum}`,
        expectedEpisodes: expectedEpisodes,
        availableEpisodes: availableCount,
        missingEpisodes: missingEpisodes,
        episodes: Object.keys(availableEpisodes)
          .sort((a, b) => parseInt(a) - parseInt(b))
          .map(epNum => availableEpisodes[epNum])
      };
    }
  }
  
  return results;
};

// Enhanced video search with pagination
const searchAllVideos = async (searchTerm = '', exactMatch = false) => {
  let allVideos = [];
  let page = 1;
  const perPage = 200;
  
  try {
    // First request to get total count
    const firstResponse = await axios.get(CONFIG.STREAM_API_BASE, {
      params: { page: 1, perPage, search: searchTerm },
      headers: { 'api-token': getApiKey() }
    });

    const { data, metadata } = firstResponse.data;
    allVideos.push(...data);

    // Continue fetching remaining pages if needed
    if (metadata.maxPage > 1) {
      const promises = [];
      for (let p = 2; p <= metadata.maxPage; p++) {
        promises.push(
          axios.get(CONFIG.STREAM_API_BASE, {
            params: { page: p, perPage, search: searchTerm },
            headers: { 'api-token': getApiKey() }
          }).then(res => res.data.data)
        );
        
        // Rate limiting: batch requests
        if (promises.length >= 3) {
          const results = await Promise.all(promises);
          results.forEach(batch => allVideos.push(...batch));
          promises.length = 0;
          await delay(500);
        }
      }
      
      // Handle remaining promises
      if (promises.length > 0) {
        const results = await Promise.all(promises);
        results.forEach(batch => allVideos.push(...batch));
      }
    }

    // Apply additional filtering if exact match requested
    if (exactMatch && searchTerm) {
      const normalized = normalize(searchTerm);
      allVideos = allVideos.filter(video => 
        normalize(video.name).includes(normalized)
      );
    }

    log(`Found ${allVideos.length} videos for search: "${searchTerm}"`);
    return allVideos;
    
  } catch (error) {
    log(`Error searching videos: ${error.message}`, 'ERROR');
    throw error;
  }
};

// Enhanced upload status check
const checkUploadStatus = async (taskId) => {
  try {
    const response = await axios.get(`${CONFIG.STREAM_UPLOAD_BASE}/advance-upload/${taskId}`, {
      headers: { 'api-token': getApiKey() }
    });
    return response.data;
  } catch (error) {
    log(`Check upload status failed: ${error.message}`, 'ERROR');
    throw error;
  }
};

// Delete video
const deleteVideo = async (videoId) => {
  try {
    await axios.delete(`${CONFIG.STREAM_API_BASE}/${videoId}`, {
      headers: { 'api-token': getApiKey() }
    });
    log(`Video deleted: ${videoId}`);
    return true;
  } catch (error) {
    log(`Delete failed [${videoId}]: ${error.message}`, 'ERROR');
    return false;
  }
};

// NEW: Clone video
const cloneVideo = async (videoId) => {
  try {
    const response = await axios.post(CONFIG.STREAM_API_BASE, {
      videoId: videoId
    }, {
      headers: {
        'api-token': getApiKey(),
        'Content-Type': 'application/json'
      }
    });
    log(`Video cloned: ${videoId}. New ID: ${response.data.id}`);
    return { success: true, newId: response.data.id };
  } catch (error) {
    log(`Clone failed [${videoId}]: ${error.message}`, 'ERROR');
    return { success: false, error: error.message };
  }
};

// Find duplicates
const findDuplicates = (videos) => {
  const duplicates = {};
  const nameMap = {};
  
  videos.forEach(video => {
    const normalizedName = normalize(video.name);
    if (nameMap[normalizedName]) {
      if (!duplicates[normalizedName]) {
        duplicates[normalizedName] = {
          originalName: nameMap[normalizedName].name,
          videos: [nameMap[normalizedName]]
        };
      }
      duplicates[normalizedName].videos.push(video);
    } else {
      nameMap[normalizedName] = video;
    }
  });
  
  return Object.values(duplicates);
};

// Enhanced clean title function that handles more formats
const cleanTitle = (raw) => {
  return raw
    // Remove file extension
    .replace(/\.[^.]+$/, '')
    // Remove existing TMDB/IMDB IDs
    .replace(/\{[^}]+\}/g, '')
    // Remove brackets, parentheses with various content
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\([^)]+\)/g, '')
    // Remove quality indicators, codecs, and other metadata
    .replace(/\b(1080p|720p|480p|2160p|4K|UHD|BluRay|WEBRip|WEB-DL|HDRip|BRRip|DVDRip|CAMRip|HDCAM|TS|TC|x264|x265|H\.264|H\.265|HEVC|AVC|DD5\.1|DTS|AC3|AAC|MP3|ESub|Esubs|MSub|MSubs|Hindi|English|Tamil|Telugu|Malayalam|Kannada|Dual\s+Audio|Multi\s+Audio|NF|Netflix|Amazon|Hotstar|ZEE5|SonyLIV|BollyFlix|MoonFlix|Vegamovies|10bit|8bit|HDR|SDR|UNRATED|EXTENDED|REMASTERED|IMAX|HQ|LQ|RARBG|YTS|YIFY|torrent|BluRay)\b/gi, '')
    // Remove website names and tags
    .replace(/\b(is|in|com|net|org|co|me|tv|to|cc|xyz|club)\b/gi, '')
    // Clean up separators
    .replace(/[._\-\+\=\~\!\@\#\$\%\^\&\*\(\)\[\]\{\}\\\/\|\;\:\'\"\<\>\,\?]+/g, ' ')
    // Remove multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
};

// Enhanced video title parsing that handles multiple formats
const parseVideoTitle = (filename) => {
  const cleaned = cleanTitle(filename);

  // Series patterns - more comprehensive
  const seriesPatterns = [
    /(.+?)\s*[Ss](\d{1,2})[.\-_\s]*[Ee](\d{1,2})/,  // S01E01, S1E1, s01e01
    /(.+?)\s*[Ss](\d{1,2})[.\-_\s]*E(\d{1,2})/,     // S01.E01
    /(.+?)\s*Season\s*(\d{1,2})\s*Episode\s*(\d{1,2})/i,  // Season 1 Episode 1
    /(.+?)\s*(\d{1,2})x(\d{1,2})/,                   // 1x01
    /(.+?)\s*S(\d{1,2})E(\d{1,2})/i                  // S1E1
  ];

  for (const pattern of seriesPatterns) {
    const seriesMatch = cleaned.match(pattern);
    if (seriesMatch) {
      return {
        title: seriesMatch[1].trim(),
        isSeries: true,
        season: parseInt(seriesMatch[2]),
        episode: parseInt(seriesMatch[3])
      };
    }
  }

  // Movie patterns - extract year if present
  const movieYearPattern = /(.+?)\s+(\d{4})\b/;
  const movieMatch = cleaned.match(movieYearPattern);

  if (movieMatch) {
    return {
      title: movieMatch[1].trim(),
      year: movieMatch[2],
      isSeries: false
    };
  }

  // Fallback - just the cleaned title
  return {
    title: cleaned,
    isSeries: false
  };
};

// NEW: Get IMDB ID from TMDB ID
const getIMDBId = async (tmdbId, type) => {
  try {
    const endpoint = type === 'tv' ? 'tv' : 'movie';
    const response = await axios.get(`${CONFIG.TMDB_BASE_URL}/${endpoint}/${tmdbId}/external_ids`, {
      params: { api_key: CONFIG.TMDB_API_KEY }
    });
    
    return response.data.imdb_id || null;
  } catch (error) {
    log(`Error fetching IMDB ID for TMDB ${tmdbId}: ${error.message}`, 'ERROR');
    return null;
  }
};

// Enhanced TMDB search with IMDB ID fetching
const searchTMDB = async (info) => {
  const type = info.isSeries ? 'tv' : 'movie';

  try {
    const response = await axios.get(`${CONFIG.TMDB_BASE_URL}/search/${type}`, {
      params: {
        api_key: CONFIG.TMDB_API_KEY,
        query: info.title,
        ...(info.year && !info.isSeries ? { year: info.year } : {})
      }
    });

    const results = response.data.results;
    if (!results || results.length === 0) return null;

    const bestMatch = results.find(r => {
      const title = (r.title || r.name || '').toLowerCase();
      return title.includes(info.title.toLowerCase());
    }) || results[0];

    // Get IMDB ID
    const imdbId = await getIMDBId(bestMatch.id, type);

    if (!info.isSeries) {
      return {
        tmdbId: bestMatch.id,
        imdbId: imdbId,
        title: bestMatch.title || bestMatch.name,
        year: (bestMatch.release_date || bestMatch.first_air_date || '').slice(0, 4)
      };
    }

    // For series, get episode info
    try {
      const epResponse = await axios.get(`${CONFIG.TMDB_BASE_URL}/tv/${bestMatch.id}/season/${info.season}/episode/${info.episode}`, {
        params: { api_key: CONFIG.TMDB_API_KEY }
      });

      return {
        tmdbId: bestMatch.id,
        imdbId: imdbId,
        seriesName: bestMatch.name,
        episodeName: epResponse.data.name || `Episode ${info.episode}`,
        season: info.season,
        episode: info.episode
      };
    } catch (episodeError) {
      // Fallback if episode details not found
      return {
        tmdbId: bestMatch.id,
        imdbId: imdbId,
        seriesName: bestMatch.name,
        episodeName: `Episode ${info.episode}`,
        season: info.season,
        episode: info.episode
      };
    }
  } catch (error) {
    log(`TMDB search error: ${error.message}`, 'ERROR');
    return null;
  }
};

// Fetch all videos from StreamP2P
const fetchAllVideos = async () => {
  return await searchAllVideos('', false);
};

// Rename video
const renameVideo = async (videoId, newName) => {
  try {
    await axios.patch(`${CONFIG.STREAM_API_BASE}/${videoId}`, {
      name: newName
    }, {
      headers: {
        'api-token': getApiKey(),
        'Content-Type': 'application/json'
      }
    });
    
    log(`Video renamed: ${newName}`);
    return true;
  } catch (error) {
    log(`Rename failed [${videoId}]: ${error.message}`, 'ERROR');
    return false;
  }
};

// API Routes

// Enhanced stream search endpoint with organization
app.get('/api/stream/search', async (req, res) => {
  try {
    const { q: searchTerm = '', exactMatch = false, organize = false } = req.query;
    
    if (!searchTerm.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'Search term is required' 
      });
    }

    log(`Stream search request: "${searchTerm}"`);
    
    const videos = await searchAllVideos(searchTerm, exactMatch === 'true');
    
    if (organize === 'true') {
      // Organize series episodes
      const organized = organizeSeriesEpisodes(videos);
      const analyzed = await checkMissingEpisodes(organized);
      
      return res.json({
        success: true,
        count: videos.length,
        organized: true,
        data: analyzed
      });
    }
    
    // Regular search results
    const results = videos.map(video => ({
      id: video.id,
      name: video.name,
      size: video.size,
      duration: video.duration,
      resolution: video.resolution,
      status: video.status,
      createdAt: video.createdAt,
      downloadUrl: `https://moonflix.p2pplay.pro/#${video.id}&dl=1`,
      streamUrl: `https://moonflix.p2pplay.pro/#${video.id}`,
      poster: video.poster,
      preview: video.preview
    }));

    res.json({
      success: true,
      count: results.length,
      organized: false,
      data: results
    });

  } catch (error) {
    log(`Stream search error: ${error.message}`, 'ERROR');
    res.status(500).json({ 
      success: false, 
      error: 'Stream search failed', 
      details: error.message 
    });
  }
});

// Enhanced upload status endpoint
app.get('/api/upload/status/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    
    const status = await checkUploadStatus(taskId);
    
    // Enhanced status information
    const enhancedStatus = {
      ...status,
      statusText: getStatusText(status.status),
      isCompleted: status.status === 'Completed',
      isFailed: status.status === 'Failed',
      isPending: status.status === 'Pending' || status.status === 'Processing',
      videoCount: status.videos ? status.videos.length : 0
    };
    
    res.json({
      success: true,
      data: enhancedStatus
    });

  } catch (error) {
    log(`Upload status check error: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Failed to check upload status',
      details: error.message
    });
  }
});

// Get status text helper
const getStatusText = (status) => {
  const statusMap = {
    'Pending': '⏳ Pending',
    'Processing': '⚙️ Processing',
    'Completed': '✅ Completed',
    'Failed': '❌ Failed',
    'Error': '⚠️ Error'
  };
  return statusMap[status] || status;
};

// Duplicate detection endpoint
app.get('/api/duplicates/scan', async (req, res) => {
  if (duplicateProgress.running) {
    return res.status(409).json({ 
      success: false, 
      error: 'Duplicate scan already in progress' 
    });
  }

  try {
    duplicateProgress = { running: true, current: 0, total: 0, status: 'Starting duplicate scan...', duplicates: [] };
    
    res.json({ 
      success: true, 
      message: 'Duplicate scan started. Check progress via /api/duplicates/progress' 
    });

    const videos = await searchAllVideos('', false);
    duplicateProgress.total = videos.length;
    duplicateProgress.status = 'Analyzing videos for duplicates...';

    const duplicates = findDuplicates(videos);
    
    duplicateProgress.duplicates = duplicates.map(dup => ({
      ...dup,
      totalSize: dup.videos.reduce((sum, video) => sum + (video.size || 0), 0),
      duplicateCount: dup.videos.length
    }));

    duplicateProgress.running = false;
    duplicateProgress.current = videos.length;
    duplicateProgress.status = `Scan completed: Found ${duplicates.length} duplicate groups`;
    log(`Duplicate scan completed: ${duplicates.length} groups found`);

  } catch (error) {
    duplicateProgress.running = false;
    duplicateProgress.status = `Error: ${error.message}`;
    log(`Duplicate scan error: ${error.message}`, 'ERROR');
  }
});

// Duplicate progress endpoint
app.get('/api/duplicates/progress', (req, res) => {
  res.json({ success: true, progress: duplicateProgress });
});

// Delete duplicate endpoint
app.delete('/api/duplicates/delete/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    const success = await deleteVideo(videoId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Video deleted successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to delete video'
      });
    }

  } catch (error) {
    log(`Delete video error: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Failed to delete video',
      details: error.message
    });
  }
});

// Batch delete duplicates endpoint
app.post('/api/duplicates/batch-delete', async (req, res) => {
  try {
    const { videoIds } = req.body;

    if (!videoIds || !Array.isArray(videoIds)) {
      return res.status(400).json({
        success: false,
        error: 'Video IDs array is required'
      });
    }

    let successful = 0;
    let failed = 0;

    for (const videoId of videoIds) {
      const success = await deleteVideo(videoId);
      if (success) {
        successful++;
      } else {
        failed++;
      }
      await delay(200); // Rate limiting
    }

    res.json({
      success: true,
      message: `Batch delete completed: ${successful} successful, ${failed} failed`,
      stats: { successful, failed, total: videoIds.length }
    });

  } catch (error) {
    log(`Batch delete error: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Batch delete failed',
      details: error.message
    });
  }
});

// Enhanced batch upload with status tracking
app.post('/api/upload/batch', async (req, res) => {
  try {
    const { uploads } = req.body;

    if (!uploads || !Array.isArray(uploads)) {
      return res.status(400).json({
        success: false,
        error: 'Uploads array is required'
      });
    }

    if (uploadProgress.running) {
      return res.status(409).json({
        success: false,
        error: 'Batch upload already in progress'
      });
    }

    uploadProgress = {
      running: true,
      current: 0,
      total: uploads.length,
      status: 'Starting batch upload...',
      uploads: [],
      taskIds: []
    };

    res.json({
      success: true,
      message: 'Batch upload started',
      total: uploads.length
    });

    // Process uploads
    for (let i = 0; i < uploads.length; i++) {
      const { url, name, folderId = '' } = uploads[i];
      
      uploadProgress.current = i + 1;
      uploadProgress.status = `Uploading: ${name}`;

      try {
        const response = await axios.post(`${CONFIG.STREAM_UPLOAD_BASE}/advance-upload`, {
          url,
          name,
          folderId
        }, {
          headers: {
            'api-token': getApiKey(),
            'Content-Type': 'application/json'
          }
        });
        
        const taskId = response.data.id;
        uploadProgress.taskIds.push(taskId);
        uploadProgress.uploads.push({
          taskId,
          name,
          url,
          status: 'uploaded',
          createdAt: new Date().toISOString()
        });

        log(`Batch upload success: ${name} (${taskId})`);
      } catch (error) {
        uploadProgress.uploads.push({
          taskId: null,
          name,
          url,
          status: 'failed',
          error: error.message,
          createdAt: new Date().toISOString()
        });

        log(`Batch upload failed: ${name} - ${error.message}`, 'ERROR');
      }

      await delay(1000); // Rate limiting
    }

    uploadProgress.running = false;
    uploadProgress.status = 'Batch upload completed';

  } catch (error) {
    uploadProgress.running = false;
    uploadProgress.status = `Batch upload error: ${error.message}`;
    log(`Batch upload error: ${error.message}`, 'ERROR');
  }
});

// Enhanced upload progress with task status checking
app.get('/api/upload/progress', async (req, res) => {
  try {
    // Check status of all active uploads
    if (uploadProgress.taskIds && uploadProgress.taskIds.length > 0) {
      const statusPromises = uploadProgress.taskIds.map(async (taskId) => {
        try {
          const status = await checkUploadStatus(taskId);
          return { taskId, ...status };
        } catch (error) {
          return { taskId, status: 'Error', error: error.message };
        }
      });

      const statuses = await Promise.all(statusPromises);
      
      res.json({
        success: true,
        progress: {
          ...uploadProgress,
          taskStatuses: statuses
        }
      });
    } else {
      res.json({
        success: true,
        progress: uploadProgress
      });
    }

  } catch (error) {
    res.json({
      success: true,
      progress: {
        ...uploadProgress,
        error: error.message
      }
    });
  }
});

// NEW: Single video clone endpoint
app.post('/api/video/clone', async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) {
      return res.status(400).json({ success: false, error: 'videoId is required' });
    }

    const result = await cloneVideo(videoId);

    if (result.success) {
      res.json({ success: true, message: `Video cloned successfully. New ID: ${result.newId}`, data: result });
    } else {
      res.status(500).json({ success: false, error: 'Failed to clone video', details: result.error });
    }
  } catch (error) {
    log(`Clone video error: ${error.message}`, 'ERROR');
    res.status(500).json({ success: false, error: 'Internal server error', details: error.message });
  }
});

// NEW: Batch video clone endpoint
app.post('/api/video/clone/batch', async (req, res) => {
  try {
    const { videoIds } = req.body; // Expecting a comma-separated string

    if (!videoIds || typeof videoIds !== 'string') {
      return res.status(400).json({ success: false, error: 'videoIds string is required' });
    }

    const ids = videoIds.split(',').map(id => id.trim()).filter(id => id);
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid video IDs provided' });
    }

    let successful = 0;
    let failed = 0;
    const results = [];

    for (const videoId of ids) {
      const result = await cloneVideo(videoId);
      if (result.success) {
        successful++;
        results.push({ originalId: videoId, newId: result.newId, status: 'success' });
      } else {
        failed++;
        results.push({ originalId: videoId, status: 'failed', error: result.error });
      }
      await delay(500); // Rate limiting
    }

    res.json({
      success: true,
      message: `Batch clone completed: ${successful} successful, ${failed} failed`,
      stats: { successful, failed, total: ids.length },
      results
    });

  } catch (error) {
    log(`Batch clone error: ${error.message}`, 'ERROR');
    res.status(500).json({ success: false, error: 'Batch clone failed', details: error.message });
  }
});

// Enhanced Dashboard HTML
app.get('/dashboard', (req, res) => {
  const { pass } = req.query;
  if (pass !== CONFIG.DASHBOARD_PASSWORD) {
    return res.status(401).send(`
      <html>
        <head><title>Unauthorized</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2>🔒 Access Denied</h2>
          <p>Invalid password</p>
        </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>StreamP2P Manager Dashboard v2.1 Professional</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh; color: #333;
        }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        .header {
          background: rgba(255, 255, 255, 0.95); border-radius: 15px;
          padding: 30px; margin-bottom: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);
          text-align: center;
        }
        .header h1 { color: #5a67d8; margin-bottom: 10px; font-size: 2.5rem; }
        .tabs { 
          display: flex; margin-bottom: 20px; background: rgba(255,255,255,0.95); 
          border-radius: 15px; overflow: hidden;
        }
        .tab { 
          flex: 1; padding: 15px; text-align: center; cursor: pointer; 
          transition: all 0.3s; border: none; background: transparent;
        }
        .tab.active { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        .tab:hover:not(.active) { background: rgba(102, 126, 234, 0.1); }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .stats-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 20px; margin-bottom: 30px;
        }
        .stat-card {
          background: rgba(255, 255, 255, 0.95); border-radius: 15px; padding: 25px;
          text-align: center; box-shadow: 0 5px 20px rgba(0,0,0,0.1);
          transition: transform 0.3s ease;
        }
        .stat-card:hover { transform: translateY(-5px); }
        .stat-number { font-size: 2.5rem; font-weight: bold; color: #5a67d8; margin-bottom: 10px; }
        .stat-label { color: #666; font-size: 1.1rem; }
        .section {
          background: rgba(255, 255, 255, 0.95); border-radius: 15px;
          padding: 25px; margin-bottom: 30px; box-shadow: 0 5px 20px rgba(0,0,0,0.1);
        }
        .btn {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white; border: none; padding: 12px 25px; border-radius: 8px;
          cursor: pointer; font-size: 1rem; font-weight: 600; margin: 5px;
          transition: all 0.3s ease; box-shadow: 0 3px 15px rgba(0,0,0,0.2);
          text-decoration: none; display: inline-block;
        }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(0,0,0,0.3); }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
        .btn-danger { background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%); }
        .btn-success { background: linear-gradient(135deg, #48bb78 0%, #38a169 100%); }
        .btn-warning { background: linear-gradient(135deg, #ed8936 0%, #dd6b20 100%); }
        .btn-small { padding: 8px 16px; font-size: 0.9rem; margin: 2px; }
        .input-group { display: flex; gap: 10px; margin-bottom: 15px; align-items: center; }
        .input-group input, .input-group select { 
          flex: 1; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 1rem; 
        }
        .input-group input:focus, .input-group select:focus { outline: none; border-color: #667eea; }
        .progress-container {
          background: rgba(255, 255, 255, 0.95); border-radius: 15px;
          padding: 25px; margin-bottom: 30px; box-shadow: 0 5px 20px rgba(0,0,0,0.1); display: none;
        }
        .progress-bar {
          background: #e2e8f0; border-radius: 10px; height: 20px; overflow: hidden; margin-bottom: 15px;
        }
        .progress-fill {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          height: 100%; transition: width 0.3s ease;
        }
        .search-box {
          width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px;
          font-size: 1rem; margin-bottom: 20px;
        }
        .search-box:focus { outline: none; border-color: #667eea; }
        .loading { text-align: center; padding: 50px; color: #666; }
        .alert { padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        .alert-success { background: #c6f6d5; color: #2f855a; border: 1px solid #9ae6b4; }
        .alert-danger { background: #fed7d7; color: #c53030; border: 1px solid #feb2b2; }
        .alert-info { background: #bee3f8; color: #2b6cb8; border: 1px solid #90cdf4; }
        .series-card {
          border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 20px;
          background: #f8fafc;
        }
        .series-header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #e2e8f0;
        }
        .series-title { font-size: 1.4rem; font-weight: bold; color: #2d3748; }
        .series-summary { 
          background: #e2e8f0; padding: 10px; border-radius: 8px; margin-bottom: 15px;
          font-size: 0.9rem; color: #4a5568;
        }
        .season-container {
          border: 1px solid #cbd5e0; border-radius: 8px; margin-bottom: 15px;
          background: white;
        }
        .season-header {
          background: #edf2f7; padding: 12px; border-radius: 8px 8px 0 0;
          font-weight: 600; display: flex; justify-content: space-between; align-items: center;
        }
        .episodes-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 10px; padding: 15px;
        }
        .episode-card {
          border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px;
          background: #f7fafc; transition: all 0.2s;
        }
        .episode-card:hover { background: #edf2f7; transform: translateY(-1px); }
        .episode-title { font-weight: 600; color: #2d3748; margin-bottom: 5px; }
        .episode-meta { font-size: 0.85rem; color: #718096; }
        .missing-episodes {
          background: #fed7d7; border: 1px solid #feb2b2; border-radius: 6px;
          padding: 10px; margin-top: 10px; color: #c53030;
        }
        .duplicate-card {
          border: 1px solid #feb2b2; border-radius: 12px; padding: 20px; margin-bottom: 20px;
          background: #fef5e7;
        }
        .duplicate-header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #f6ad55;
        }
        .duplicate-item {
          border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin-bottom: 10px;
          background: white; display: flex; justify-content: space-between; align-items: center;
        }
        .video-info h4 { margin-bottom: 5px; color: #2d3748; }
        .video-meta { font-size: 0.9rem; color: #666; }
        .status-badge {
          padding: 4px 12px; border-radius: 20px; font-size: 0.85rem; font-weight: 600;
          margin-left: 10px;
        }
        .status-completed { background: #c6f6d5; color: #2f855a; }
        .status-pending { background: #fed7aa; color: #c05621; }
        .status-failed { background: #fed7d7; color: #c53030; }
        .status-processing { background: #bee3f8; color: #2b6cb8; }
        .upload-status-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
          gap: 15px; margin-top: 20px;
        }
        .upload-status-card {
          border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; background: white;
        }
        .rename-failure-item {
            display: flex; flex-direction: column; gap: 10px; padding: 15px;
            border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 10px;
        }
        @media (max-width: 768px) {
          .container { padding: 10px; }
          .header h1 { font-size: 2rem; }
          .stats-grid { grid-template-columns: 1fr; }
          .tabs { flex-direction: column; }
          .input-group { flex-direction: column; }
          .episodes-grid { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🎬 StreamP2P Manager v2.1 Professional</h1>
          <p>Professional Content Management with Episode Organization, Duplicate Detection & IMDB Integration</p>
        </div>

        <div class="tabs">
          <button class="tab active" onclick="switchTab('dashboard')">📊 Dashboard</button>
          <button class="tab" onclick="switchTab('search')">🔍 Search</button>
          <button class="tab" onclick="switchTab('upload')">📤 Upload</button>
          <button class="tab" onclick="switchTab('duplicates')">🔄 Duplicates</button>
          <button class="tab" onclick="switchTab('manage')">🛠️ Manage</button>
        </div>

        <!-- Dashboard Tab -->
        <div id="dashboard-tab" class="tab-content active">
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-number" id="totalRequests">-</div>
              <div class="stat-label">Total Requests</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" id="totalCount">-</div>
              <div class="stat-label">Request Count</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" id="movieRequests">-</div>
              <div class="stat-label">Movie Requests</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" id="seriesRequests">-</div>
              <div class="stat-label">Series Requests</div>
            </div>
          </div>

          <div class="section">
            <h3>📊 Content Requests</h3>
            <input type="text" class="search-box" id="searchBox" placeholder="🔍 Search requests...">
            <div id="alertContainer"></div>
            <div class="loading" id="loading">Loading data...</div>
            <table id="dataTable" style="display: none; width: 100%; border-collapse: collapse;">
              <thead>
                <tr style="background: #f8fafc;">
                  <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">TMDB ID</th>
                  <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">Title</th>
                  <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">Type</th>
                  <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">Count</th>
                  <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">Last Requested</th>
                  <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">Status</th>
                  <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">Actions</th>
                </tr>
              </thead>
              <tbody id="tableBody"></tbody>
            </table>
          </div>
        </div>

        <!-- Search Tab -->
        <div id="search-tab" class="tab-content">
          <div class="section">
            <h3>🔍 Search StreamP2P Videos</h3>
            <div class="input-group">
              <input type="text" id="videoSearchInput" placeholder="Enter movie/series title...">
              <button class="btn" onclick="searchVideos()">🔍 Search</button>
              <button class="btn" onclick="searchVideos(true)">🎯 Exact Match</button>
              <button class="btn btn-success" onclick="searchVideos(false, true)">📺 Organize Series</button>
            </div>
            <div id="searchLoading" class="loading" style="display: none;">Searching...</div>
            <div id="searchResults"></div>
          </div>
        </div>

        <!-- Upload Tab -->
        <div id="upload-tab" class="tab-content">
          <div class="section">
            <h3>📤 Upload Content</h3>
            
            <div style="margin-bottom: 30px;">
              <h4>🔗 Upload from URL/Torrent</h4>
              <div class="input-group">
                <input type="text" id="uploadUrl" placeholder="Direct link, magnet link, or torrent URL">
                <input type="text" id="uploadName" placeholder="Video name">
                <button class="btn btn-success" onclick="uploadFromUrl()">📤 Upload</button>
              </div>
            </div>

            <div style="margin-bottom: 30px;">
              <h4>📝 Batch Upload</h4>
              <textarea id="batchUploadList" rows="10" style="width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px;" 
                placeholder="Format: URL|Name (one per line)
Example:
https://example.com/movie.mp4|Movie Title 2024
magnet:?xt=urn:btih:abc123|Series S01E01"></textarea>
              <button class="btn btn-success" onclick="batchUpload()">📤 Start Batch Upload</button>
            </div>

            <div style="margin-bottom: 30px;">
              <h4>💾 Get TUS Endpoint (for file uploads)</h4>
              <button class="btn" onclick="getTusEndpoint()">📋 Get Upload Endpoint</button>
              <div id="tusInfo" style="margin-top: 10px; padding: 10px; background: #f8fafc; border-radius: 8px; display: none;"></div>
            </div>

            <div style="margin-top: 30px;">
              <h4>🔁 Clone Existing Video</h4>
              <p style="color: #666; margin-bottom: 15px;">Create a copy of an existing video on the server using its ID.</p>
              
              <div style="margin-bottom: 30px;">
                <h5>Single Clone</h5>
                <div class="input-group">
                  <input type="text" id="cloneVideoId" placeholder="Enter Video ID to clone">
                  <button class="btn btn-warning" onclick="cloneSingleVideo(event)">🔁 Clone Video</button>
                </div>
              </div>

              <div>
                <h5>Batch Clone</h5>
                <textarea id="batchCloneIds" rows="5" style="width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px;" 
                  placeholder="Enter multiple Video IDs, separated by commas"></textarea>
                <button class="btn btn-warning" onclick="batchCloneVideos(event)">🔁 Start Batch Clone</button>
              </div>
            </div>
          </div>

          <div class="progress-container" id="uploadProgressContainer">
            <h4>📤 Upload Progress</h4>
            <div class="progress-bar">
              <div class="progress-fill" id="uploadProgressFill"></div>
            </div>
            <div id="uploadProgressText">Ready...</div>
            <div id="uploadStatusGrid" class="upload-status-grid"></div>
          </div>
        </div>

        <!-- Duplicates Tab -->
        <div id="duplicates-tab" class="tab-content">
          <div class="section">
            <h3>🔄 Duplicate Detection</h3>
            <p style="margin-bottom: 20px; color: #666;">Scan your video library for duplicate files and manage them efficiently.</p>
            
            <div class="input-group">
              <button class="btn btn-warning" onclick="scanDuplicates()">🔍 Scan for Duplicates</button>
              <button class="btn btn-danger" onclick="deleteAllDuplicates()" id="deleteAllBtn" style="display: none;">🗑️ Delete All Duplicates</button>
            </div>
          </div>

          <div class="progress-container" id="duplicateProgressContainer">
            <h4>🔄 Duplicate Scan Progress</h4>
            <div class="progress-bar">
              <div class="progress-fill" id="duplicateProgressFill"></div>
            </div>
            <div id="duplicateProgressText">Ready...</div>
          </div>

          <div id="duplicateResults" class="section" style="display: none;">
            <h4>🔍 Duplicate Results</h4>
            <div id="duplicateList"></div>
          </div>
        </div>

        <!-- Manage Tab -->
        <div id="manage-tab" class="tab-content">
          <div class="section">
            <h3 style="margin-bottom: 20px;">🛠️ Management Tools</h3>
            <div class="input-group">
              <button class="btn" onclick="refreshData()">🔄 Refresh Data</button>
              <button class="btn" onclick="startBatchRename()">🏷️ Rename All Videos (with IMDB ID)</button>
              <button class="btn btn-danger" onclick="clearRequests()">🗑️ Clear All Requests</button>
            </div>
            
            <div class="alert alert-info" style="margin-top: 20px;">
              <strong>🎬 Enhanced Rename Feature:</strong> Now includes IMDB ID integration!<br>
              <strong>Movies:</strong> Movie Title Year {TMDB_ID} {IMDB_ID}.mkv<br>
              <strong>Series:</strong> Series Name S01-E01-Episode Title {TMDB_ID} {IMDB_ID}.mkv<br>
              <strong>Supported formats:</strong> Multiple quality tags, dual audio, various separators and more!
            </div>
          </div>

          <div class="progress-container" id="progressContainer">
            <h4>🔄 Batch Rename Progress</h4>
            <div class="progress-bar">
              <div class="progress-fill" id="progressFill"></div>
            </div>
            <div id="progressText">Initializing...</div>
          </div>

          <div class="section" id="renameFailuresContainer" style="display: none;">
            <h3>❌ Rename Failures</h3>
            <p style="color: #666; margin-bottom: 15px;">The following videos could not be renamed automatically. You can correct them manually below.</p>
            <div id="renameFailuresList"></div>
            <button class="btn btn-warning" onclick="document.getElementById('renameFailuresContainer').style.display = 'none'">Clear Failures List</button>
          </div>
        </div>
      </div>

      <script>
        let allData = [];
        let progressInterval;
        let uploadInterval;
        let duplicateInterval;

        // Tab switching
        function switchTab(tabName) {
          document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
          document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
          
          document.getElementById(tabName + '-tab').classList.add('active');
          event.target.classList.add('active');
        }

        // Load dashboard data
        async function loadData() {
          try {
            document.getElementById('loading').style.display = 'block';
            document.getElementById('dataTable').style.display = 'none';
            
            const response = await fetch('/api/dashboard/data');
            const result = await response.json();
            
            if (result.success) {
              allData = result.data;
              updateStats(result.stats);
              renderTable(allData);
            } else {
              showAlert('Failed to load data: ' + result.error, 'danger');
            }
          } catch (error) {
            showAlert('Error loading data: ' + error.message, 'danger');
          } finally {
            document.getElementById('loading').style.display = 'none';
            document.getElementById('dataTable').style.display = 'table';
          }
        }

        // Update statistics
        function updateStats(stats) {
          document.getElementById('totalRequests').textContent = stats.totalRequests;
          document.getElementById('totalCount').textContent = stats.totalCount;
          document.getElementById('movieRequests').textContent = stats.movieRequests;
          document.getElementById('seriesRequests').textContent = stats.seriesRequests;
        }

        // Render data table
        function renderTable(data) {
          const tbody = document.getElementById('tableBody');
          tbody.innerHTML = '';
          
          data.forEach(item => {
            const row = tbody.insertRow();
            row.id = \`request-\${item.tmdbId}\`;
            row.innerHTML = \`
              <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">\${item.tmdbId}</td>
              <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">\${item.title}</td>
              <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
                <span class="status-badge status-\${item.type === 'movie' ? 'completed' : 'processing'}">\${item.type.toUpperCase()}</span>
              </td>
              <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;"><strong>\${item.count}</strong></td>
              <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">\${new Date(item.lastRequested).toLocaleString()}</td>
              <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
                <span class="status-badge status-completed">\${item.status || 'Requested'}</span>
              </td>
              <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
                <button class="btn btn-small btn-danger" onclick="deleteRequest('\${item.tmdbId}', this)">🗑️ Delete</button>
              </td>
            \`;
          });
        }

        // NEW: Delete a single request
        async function deleteRequest(tmdbId, button) {
            if (!confirm(\`Are you sure you want to delete the request for TMDB ID: \${tmdbId}?\`)) {
                return;
            }

            button.disabled = true;
            button.textContent = 'Deleting...';

            try {
                const response = await fetch(\`/api/requests/\${tmdbId}\`, { method: 'DELETE' });
                const result = await response.json();

                if (result.success) {
                    showAlert('Request deleted successfully!', 'success');
                    const row = document.getElementById(\`request-\${tmdbId}\`);
                    if (row) {
                        row.style.transition = 'opacity 0.5s';
                        row.style.opacity = '0';
                        setTimeout(() => row.remove(), 500);
                    }
                    // Optionally, reload all data to update stats
                    loadData();
                } else {
                    showAlert('Failed to delete request: ' + result.error, 'danger');
                    button.disabled = false;
                    button.textContent = '🗑️ Delete';
                }
            } catch (error) {
                showAlert('Error deleting request: ' + error.message, 'danger');
                button.disabled = false;
                button.textContent = '🗑️ Delete';
            }
        }

        // Search functionality
        document.getElementById('searchBox').addEventListener('input', function() {
          const query = this.value.toLowerCase();
          const filtered = allData.filter(item => 
            item.title.toLowerCase().includes(query) || 
            item.tmdbId.toString().includes(query)
          );
          renderTable(filtered);
        });

        // Enhanced search videos with organization
        async function searchVideos(exactMatch = false, organize = false) {
          const searchTerm = document.getElementById('videoSearchInput').value.trim();
          if (!searchTerm) {
            showAlert('Please enter a search term', 'danger');
            return;
          }

          document.getElementById('searchLoading').style.display = 'block';
          document.getElementById('searchResults').innerHTML = '';

          try {
            const response = await fetch(\`/api/stream/search?q=\${encodeURIComponent(searchTerm)}&exactMatch=\${exactMatch}&organize=\${organize}\`);
            const result = await response.json();

            if (result.success) {
              if (result.organized) {
                displayOrganizedResults(result.data, Object.keys(result.data).length);
              } else {
                displaySearchResults(result.data, result.count);
              }
              showAlert(\`Found \${result.count} videos\`, 'success');
            } else {
              showAlert('Search failed: ' + result.error, 'danger');
            }
          } catch (error) {
            showAlert('Search error: ' + error.message, 'danger');
          } finally {
            document.getElementById('searchLoading').style.display = 'none';
          }
        }

        // Display organized series results
        function displayOrganizedResults(seriesData, count) {
          const container = document.getElementById('searchResults');
          
          if (count === 0) {
            container.innerHTML = '<p>No series found.</p>';
            return;
          }

          let html = \`<h4>📺 Found \${count} series with organized episodes:</h4>\`;
          
          Object.values(seriesData).forEach(series => {
            const totalSeasons = series.summary.totalSeasons;
            const availableSeasons = series.summary.seasonsAvailable;
            const missingSeasons = series.summary.missingSeasons;
            
            html += \`
              <div class="series-card">
                <div class="series-header">
                  <h3 class="series-title">\${series.seriesName}</h3>
                  <span class="status-badge status-completed">TMDB: \${series.tmdbId}</span>
                </div>
                
                <div class="series-summary">
                  📊 <strong>Summary:</strong> \${availableSeasons}/\${totalSeasons} seasons available
                  \${missingSeasons.length > 0 ? \`• Missing seasons: \${missingSeasons.join(', ')}\` : ''}
                </div>
            \`;
            
            Object.keys(series.seasons).sort((a, b) => parseInt(a) - parseInt(b)).forEach(seasonNum => {
              const season = series.seasons[seasonNum];
              const missingCount = season.missingEpisodes.length;
              
              html += \`
                <div class="season-container">
                  <div class="season-header">
                    <span>🎬 \${season.name}</span>
                    <span>\${season.availableEpisodes}/\${season.expectedEpisodes} episodes
                      \${missingCount > 0 ? \`• \${missingCount} missing\` : ' ✅'}</span>
                  </div>
                  
                  <div class="episodes-grid">
              \`;
              
              season.episodes.forEach(episode => {
                const size = (episode.size / (1024 * 1024 * 1024)).toFixed(2);
                const duration = Math.floor(episode.duration / 60);
                
                html += \`
                  <div class="episode-card">
                    <div class="episode-title">\${episode.name}</div>
                    <div class="episode-meta">
                      📊 \${size} GB • ⏱️ \${duration} min • 🎬 \${episode.resolution}
                    </div>
                    <div style="margin-top: 8px;">
                      <a href="https://moonflix.p2pplay.pro/#\${episode.id}" target="_blank" class="btn btn-small">▶️ Stream</a>
                      <a href="https://moonflix.p2pplay.pro/#\${episode.id}&dl=1" target="_blank" class="btn btn-small btn-success">⬇️ Download</a>
                    </div>
                  </div>
                \`;
              });
              
              html += '</div>';
              
              if (season.missingEpisodes.length > 0) {
                html += \`
                  <div class="missing-episodes">
                    ❌ Missing episodes: \${season.missingEpisodes.join(', ')}
                  </div>
                \`;
              }
              
              html += '</div>';
            });
            
            html += '</div>';
          });
          
          container.innerHTML = html;
        }

        // Display regular search results
        function displaySearchResults(videos, count) {
          const container = document.getElementById('searchResults');
          
          if (count === 0) {
            container.innerHTML = '<p>No videos found.</p>';
            return;
          }

          let html = \`<h4>🎬 Found \${count} videos:</h4>\`;
          
          videos.forEach(video => {
            const size = (video.size / (1024 * 1024 * 1024)).toFixed(2);
            const duration = Math.floor(video.duration / 60);
            
            html += \`
              <div class="duplicate-item">
                <div class="video-info">
                  <h4>\${video.name}</h4>
                  <div class="video-meta">
                    📊 \${size} GB • ⏱️ \${duration} min • 🎬 \${video.resolution} • 📅 \${new Date(video.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div>
                  <a href="\${video.streamUrl}" target="_blank" class="btn btn-small">▶️ Stream</a>
                  <a href="\${video.downloadUrl}" target="_blank" class="btn btn-small btn-success">⬇️ Download</a>
                </div>
              </div>
            \`;
          });
          
          container.innerHTML = html;
        }

        // Upload from URL
        async function uploadFromUrl() {
          const url = document.getElementById('uploadUrl').value.trim();
          const name = document.getElementById('uploadName').value.trim();

          if (!url || !name) {
            showAlert('Please enter both URL and name', 'danger');
            return;
          }

          try {
            const response = await fetch('/api/upload/url', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url, name })
            });

            const result = await response.json();

            if (result.success) {
              showAlert(\`Upload started: \${result.taskId}\`, 'success');
              document.getElementById('uploadUrl').value = '';
              document.getElementById('uploadName').value = '';
              startUploadProgressTracking();
            } else {
              showAlert('Upload failed: ' + result.error, 'danger');
            }
          } catch (error) {
            showAlert('Upload error: ' + error.message, 'danger');
          }
        }

        // Batch upload
        async function batchUpload() {
          const batchText = document.getElementById('batchUploadList').value.trim();
          if (!batchText) {
            showAlert('Please enter batch upload list', 'danger');
            return;
          }

          const lines = batchText.split('\\n').filter(line => line.trim());
          const uploads = [];

          for (const line of lines) {
            const parts = line.split('|');
            if (parts.length >= 2) {
              uploads.push({
                url: parts[0].trim(),
                name: parts[1].trim()
              });
            }
          }

          if (uploads.length === 0) {
            showAlert('No valid uploads found in the list', 'danger');
            return;
          }

          try {
            const response = await fetch('/api/upload/batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uploads })
            });

            const result = await response.json();

            if (result.success) {
              showAlert(\`Batch upload started: \${result.total} files\`, 'success');
              document.getElementById('batchUploadList').value = '';
              startUploadProgressTracking();
            } else {
              showAlert('Batch upload failed: ' + result.error, 'danger');
            }
          } catch (error) {
            showAlert('Batch upload error: ' + error.message, 'danger');
          }
        }

        // Enhanced upload progress tracking
        function startUploadProgressTracking() {
          document.getElementById('uploadProgressContainer').style.display = 'block';
          
          uploadInterval = setInterval(async () => {
            try {
              const response = await fetch('/api/upload/progress');
              const result = await response.json();
              
              if (result.success) {
                const progress = result.progress;
                const percentage = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
                
                document.getElementById('uploadProgressFill').style.width = percentage + '%';
                document.getElementById('uploadProgressText').textContent = 
                  \`\${progress.current}/\${progress.total} - \${progress.status}\`;
                
                // Update upload status grid
                if (progress.taskStatuses) {
                  updateUploadStatusGrid(progress.taskStatuses);
                }
                
                if (!progress.running && progress.current > 0) {
                  clearInterval(uploadInterval);
                  setTimeout(() => {
                    document.getElementById('uploadProgressContainer').style.display = 'none';
                  }, 10000);
                  showAlert('Upload process completed!', 'success');
                }
              }
            } catch (error) {
              clearInterval(uploadInterval);
              showAlert('Upload progress tracking error: ' + error.message, 'danger');
            }
          }, 3000);
        }

        // Update upload status grid
        function updateUploadStatusGrid(taskStatuses) {
          const grid = document.getElementById('uploadStatusGrid');
          
          grid.innerHTML = taskStatuses.map(task => \`
            <div class="upload-status-card">
              <h5 style="margin-bottom: 10px;">📤 \${task.name || task.taskId}</h5>
              <div>
                <span class="status-badge status-\${getStatusClass(task.status)}">\${getStatusText(task.status)}</span>
              </div>
              <div style="margin-top: 10px; font-size: 0.9rem; color: #666;">
                <div>Task ID: \${task.taskId}</div>
                <div>Updated: \${new Date(task.updatedAt || task.createdAt).toLocaleString()}</div>
                \${task.videos ? \`<div>Videos: \${task.videos.length}</div>\` : ''}
              </div>
            </div>
          \`).join('');
        }

        // Get status class for styling
        function getStatusClass(status) {
          const statusMap = {
            'Completed': 'completed',
            'Processing': 'processing',
            'Pending': 'pending',
            'Failed': 'failed',
            'Error': 'failed'
          };
          return statusMap[status] || 'pending';
        }

        // Get status text
        function getStatusText(status) {
          const statusMap = {
            'Pending': '⏳ Pending',
            'Processing': '⚙️ Processing',
            'Completed': '✅ Completed',
            'Failed': '❌ Failed',
            'Error': '⚠️ Error'
          };
          return statusMap[status] || status;
        }

        // Scan for duplicates
        async function scanDuplicates() {
          try {
            const response = await fetch('/api/duplicates/scan');
            const result = await response.json();

            if (result.success) {
              showAlert('Duplicate scan started!', 'info');
              startDuplicateProgressTracking();
            } else {
              showAlert('Failed to start duplicate scan: ' + result.error, 'danger');
            }
          } catch (error) {
            showAlert('Error: ' + error.message, 'danger');
          }
        }

        // Track duplicate scan progress
        function startDuplicateProgressTracking() {
          document.getElementById('duplicateProgressContainer').style.display = 'block';
          
          duplicateInterval = setInterval(async () => {
            try {
              const response = await fetch('/api/duplicates/progress');
              const result = await response.json();
              
              if (result.success) {
                const progress = result.progress;
                const percentage = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
                
                document.getElementById('duplicateProgressFill').style.width = percentage + '%';
                document.getElementById('duplicateProgressText').textContent = 
                  \`\${progress.current}/\${progress.total} - \${progress.status}\`;
                
                if (!progress.running) {
                  clearInterval(duplicateInterval);
                  displayDuplicateResults(progress.duplicates);
                  setTimeout(() => {
                    document.getElementById('duplicateProgressContainer').style.display = 'none';
                  }, 3000);
                  showAlert('Duplicate scan completed!', 'success');
                }
              }
            } catch (error) {
              clearInterval(duplicateInterval);
              showAlert('Duplicate progress tracking error: ' + error.message, 'danger');
            }
          }, 2000);
        }

        // Display duplicate results
        function displayDuplicateResults(duplicates) {
          const resultsDiv = document.getElementById('duplicateResults');
          const listDiv = document.getElementById('duplicateList');
          
          if (duplicates.length === 0) {
            listDiv.innerHTML = '<div class="alert alert-success">🎉 No duplicates found! Your library is clean.</div>';
            resultsDiv.style.display = 'block';
            return;
          }

          document.getElementById('deleteAllBtn').style.display = 'inline-block';
          
          let html = \`<div class="alert alert-info">🔍 Found \${duplicates.length} duplicate groups</div>\`;
          
          duplicates.forEach((group, index) => {
            const totalSize = (group.totalSize / (1024 * 1024 * 1024)).toFixed(2);
            
            html += \`
              <div class="duplicate-card">
                <div class="duplicate-header">
                  <h4>📁 \${group.originalName}</h4>
                  <div>
                    <span class="status-badge status-warning">\${group.duplicateCount} copies</span>
                    <span class="status-badge status-failed">\${totalSize} GB total</span>
                  </div>
                </div>
                
                <div>
            \`;
            
            group.videos.forEach((video, videoIndex) => {
              const size = (video.size / (1024 * 1024 * 1024)).toFixed(2);
              const duration = Math.floor(video.duration / 60);
              
              html += \`
                <div class="duplicate-item">
                  <div class="video-info">
                    <h4>\${video.name}</h4>
                    <div class="video-meta">
                      📊 \${size} GB • ⏱️ \${duration} min • 🎬 \${video.resolution} • 📅 \${new Date(video.createdAt).toLocaleDateString()}
                      <br>ID: \${video.id}
                    </div>
                  </div>
                  <div>
                    <a href="https://moonflix.p2pplay.pro/#\${video.id}" target="_blank" class="btn btn-small">▶️ Stream</a>
                    <a href="https://moonflix.p2pplay.pro/#\${video.id}&dl=1" target="_blank" class="btn btn-small btn-success">⬇️ Download</a>
                    \${videoIndex > 0 ? \`<button class="btn btn-small btn-danger" onclick="deleteDuplicate('\${video.id}', this)">🗑️ Delete</button>\` : \`<span class="status-badge status-completed">Keep Original</span>\`}
                  </div>
                </div>
              \`;
            });
            
            html += \`
                </div>
                <div style="margin-top: 15px; text-align: right;">
                  <button class="btn btn-danger btn-small" onclick="deleteGroupDuplicates(\${index})">🗑️ Delete All Duplicates in Group</button>
                </div>
              </div>
            \`;
          });
          
          listDiv.innerHTML = html;
          resultsDiv.style.display = 'block';
          
          // Store duplicates data for deletion
          window.duplicatesData = duplicates;
        }

        // Delete single duplicate
        async function deleteDuplicate(videoId, buttonElement) {
          if (!confirm('Are you sure you want to delete this duplicate?')) return;
          
          buttonElement.disabled = true;
          buttonElement.textContent = '⏳ Deleting...';
          
          try {
            const response = await fetch(\`/api/duplicates/delete/\${videoId}\`, {
              method: 'DELETE'
            });
            
            const result = await response.json();
            
            if (result.success) {
              buttonElement.textContent = '✅ Deleted';
              buttonElement.classList.remove('btn-danger');
              buttonElement.classList.add('btn-success');
              showAlert('Video deleted successfully', 'success');
            } else {
              buttonElement.disabled = false;
              buttonElement.textContent = '🗑️ Delete';
              showAlert('Failed to delete video: ' + result.error, 'danger');
            }
          } catch (error) {
            buttonElement.disabled = false;
            buttonElement.textContent = '🗑️ Delete';
            showAlert('Delete error: ' + error.message, 'danger');
          }
        }

        // Delete duplicates in a group
        async function deleteGroupDuplicates(groupIndex) {
          const group = window.duplicatesData[groupIndex];
          const videosToDelete = group.videos.slice(1); // Keep first, delete rest
          
          if (!confirm(\`Delete \${videosToDelete.length} duplicate copies of "\${group.originalName}"?\`)) return;
          
          try {
            const videoIds = videosToDelete.map(v => v.id);
            const response = await fetch('/api/duplicates/batch-delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoIds })
            });
            
            const result = await response.json();
            
            if (result.success) {
              showAlert(result.message, 'success');
              // Refresh duplicate scan
              setTimeout(() => scanDuplicates(), 2000);
            } else {
              showAlert('Batch delete failed: ' + result.error, 'danger');
            }
          } catch (error) {
            showAlert('Batch delete error: ' + error.message, 'danger');
          }
        }

        // Delete all duplicates
        async function deleteAllDuplicates() {
          const allDuplicates = window.duplicatesData || [];
          const totalVideos = allDuplicates.reduce((sum, group) => sum + (group.videos.length - 1), 0);
          
          if (!confirm(\`This will delete \${totalVideos} duplicate videos. Continue?\`)) return;
          
          try {
            const allVideoIds = [];
            allDuplicates.forEach(group => {
              group.videos.slice(1).forEach(video => allVideoIds.push(video.id));
            });
            
            const response = await fetch('/api/duplicates/batch-delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoIds: allVideoIds })
            });
            
            const result = await response.json();
            
            if (result.success) {
              showAlert(result.message, 'success');
              document.getElementById('duplicateResults').style.display = 'none';
              document.getElementById('deleteAllBtn').style.display = 'none';
            } else {
              showAlert('Batch delete failed: ' + result.error, 'danger');
            }
          } catch (error) {
            showAlert('Batch delete error: ' + error.message, 'danger');
          }
        }

        // Get TUS endpoint
        async function getTusEndpoint() {
          try {
            const response = await fetch('/api/upload/tus');
            const result = await response.json();

            if (result.success) {
              const tusInfo = document.getElementById('tusInfo');
              tusInfo.innerHTML = \`
                <h5>🔗 TUS Upload Endpoint:</h5>
                <p><strong>URL:</strong> \${result.data.tusUrl}</p>
                <p><strong>Access Token:</strong> \${result.data.accessToken}</p>
                <p><strong>Chunk Size:</strong> 52,428,800 bytes</p>
                <small>💡 Use tus-js-client or similar library for file uploads</small>
              \`;
              tusInfo.style.display = 'block';
            } else {
              showAlert('Failed to get TUS endpoint: ' + result.error, 'danger');
            }
          } catch (error) {
            showAlert('TUS endpoint error: ' + error.message, 'danger');
          }
        }

        // NEW: Clone a single video with enhanced feedback
        async function cloneSingleVideo(event) {
          const videoId = document.getElementById('cloneVideoId').value.trim();
          if (!videoId) {
            showAlert('Please enter a Video ID to clone.', 'danger');
            return;
          }

          const button = event.target;
          button.disabled = true;
          button.textContent = '🔁 Cloning...';

          try {
            const response = await fetch('/api/video/clone', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoId })
            });

            const result = await response.json();

            if (result.success) {
              showAlert(result.message, 'success');
              document.getElementById('cloneVideoId').value = '';
            } else {
              const errorMessage = result.details || result.error;
              showAlert('Clone failed: ' + errorMessage, 'danger');
            }
          } catch (error) {
            showAlert('Clone error: ' + error.message, 'danger');
          } finally {
            button.disabled = false;
            button.textContent = '🔁 Clone Video';
          }
        }

        // NEW: Batch clone videos with enhanced feedback
        async function batchCloneVideos(event) {
          const videoIds = document.getElementById('batchCloneIds').value.trim();
          if (!videoIds) {
            showAlert('Please enter Video IDs for batch cloning.', 'danger');
            return;
          }

          const button = event.target;
          button.disabled = true;
          button.textContent = '🔁 Cloning...';

          try {
            const response = await fetch('/api/video/clone/batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoIds })
            });

            const result = await response.json();

            if (result.success) {
              showAlert(result.message, 'success');
              if (result.results) {
                console.log('Batch Clone Results:', result.results);
              }
              document.getElementById('batchCloneIds').value = '';
            } else {
              const errorMessage = result.details || result.error;
              showAlert('Batch clone failed: ' + errorMessage, 'danger');
            }
          } catch (error) {
            showAlert('Batch clone error: ' + error.message, 'danger');
          } finally {
            button.disabled = false;
            button.textContent = '🔁 Start Batch Clone';
          }
        }

        // Show alerts
        function showAlert(message, type) {
          const container = document.getElementById('alertContainer');
          const alert = document.createElement('div');
          alert.className = \`alert alert-\${type}\`;
          alert.textContent = message;
          container.appendChild(alert);
          
          setTimeout(() => {
            if (alert.parentNode) alert.remove();
          }, 5000);
        }

        // Refresh data
        function refreshData() {
          loadData();
        }

        // Start batch rename
        async function startBatchRename() {
          if (confirm('This will rename all videos in StreamP2P with TMDB and IMDB IDs. Continue?')) {
            try {
              document.getElementById('renameFailuresContainer').style.display = 'none';
              const response = await fetch('/api/rename/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              
              const result = await response.json();
              
              if (result.success) {
                showAlert('Enhanced batch rename started with IMDB integration!', 'success');
                startProgressTracking();
              } else {
                showAlert('Failed to start batch rename: ' + result.error, 'danger');
              }
            } catch (error) {
              showAlert('Error: ' + error.message, 'danger');
            }
          }
        }

        // Track rename progress
        function startProgressTracking() {
          document.getElementById('progressContainer').style.display = 'block';
          
          progressInterval = setInterval(async () => {
            try {
              const response = await fetch('/api/rename/progress');
              const result = await response.json();
              
              if (result.success) {
                const progress = result.progress;
                const percentage = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
                
                document.getElementById('progressFill').style.width = percentage + '%';
                document.getElementById('progressText').textContent = 
                  \`\${progress.current}/\${progress.total} - \${progress.status}\`;
                
                if (!progress.running) {
                  clearInterval(progressInterval);
                  setTimeout(() => {
                    document.getElementById('progressContainer').style.display = 'none';
                  }, 3000);
                  showAlert('Enhanced batch rename completed!', 'success');
                  if (progress.failures && progress.failures.length > 0) {
                    displayRenameFailures(progress.failures);
                  }
                }
              }
            } catch (error) {
              clearInterval(progressInterval);
              showAlert('Progress tracking error: ' + error.message, 'danger');
            }
          }, 2000);
        }

        // NEW: Display rename failures
        function displayRenameFailures(failures) {
            const container = document.getElementById('renameFailuresContainer');
            const list = document.getElementById('renameFailuresList');
            list.innerHTML = '';

            failures.forEach(failure => {
                const item = document.createElement('div');
                item.className = 'rename-failure-item';
                item.id = \`failure-\${failure.id}\`;
                item.innerHTML = \`
                    <div>
                        <strong>Original Name:</strong>
                        <p style="font-family: monospace; background: #f1f1f1; padding: 5px; border-radius: 4px;">\${failure.name}</p>
                    </div>
                    <div class="input-group">
                        <input type="text" id="newName-\${failure.id}" placeholder="Enter new name...">
                        <button class="btn btn-small btn-warning" onclick="manualRename('\${failure.id}', this)">🏷️ Rename</button>
                    </div>
                \`;
                list.appendChild(item);
            });

            container.style.display = 'block';
        }

        // NEW: Manual rename function
        async function manualRename(videoId, button) {
            const newName = document.getElementById(\`newName-\${videoId}\`).value.trim();
            if (!newName) {
                showAlert('Please enter a new name.', 'danger');
                return;
            }

            button.disabled = true;
            button.textContent = 'Renaming...';

            try {
                const response = await fetch('/api/rename/manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ videoId, newName })
                });
                const result = await response.json();

                if (result.success) {
                    showAlert('Video renamed successfully!', 'success');
                    const item = document.getElementById(\`failure-\${videoId}\`);
                    item.innerHTML = \`<div class="alert alert-success">✅ Renamed successfully to: \${newName}</div>\`;
                } else {
                    showAlert('Rename failed: ' + result.error, 'danger');
                    button.disabled = false;
                    button.textContent = '🏷️ Rename';
                }
            } catch (error) {
                showAlert('Error during manual rename: ' + error.message, 'danger');
                button.disabled = false;
                button.textContent = '🏷️ Rename';
            }
        }

        // Clear all requests
        async function clearRequests() {
          if (confirm('This will delete all request data. Continue?')) {
            try {
              const response = await fetch('/api/requests/clear', {
                method: 'DELETE'
              });
              
              if (response.ok) {
                showAlert('All requests cleared!', 'success');
                loadData();
              } else {
                showAlert('Failed to clear requests', 'danger');
              }
            } catch (error) {
              showAlert('Error: ' + error.message, 'danger');
            }
          }
        }

        // Initialize dashboard
        loadData();
        
        // Auto-refresh every 30 seconds
        setInterval(loadData, 30000);

        // Search on Enter key
        document.getElementById('videoSearchInput').addEventListener('keypress', function(e) {
          if (e.key === 'Enter') {
            searchVideos();
          }
        });

        // Cleanup intervals on page unload
        window.addEventListener('beforeunload', () => {
          if (progressInterval) clearInterval(progressInterval);
          if (uploadInterval) clearInterval(uploadInterval);
          if (duplicateInterval) clearInterval(duplicateInterval);
        });
      </script>
    </body>
    </html>
  `);
});

// Upload from URL/Torrent
const uploadFromUrl = async (url, name, folderId = '') => {
  try {
    const response = await axios.post(`${CONFIG.STREAM_UPLOAD_BASE}/advance-upload`, {
      url,
      name,
      folderId
    }, {
      headers: {
        'api-token': getApiKey(),
        'Content-Type': 'application/json'
      }
    });

    return { success: true, taskId: response.data.id };
  } catch (error) {
    log(`Upload from URL failed: ${error.message}`, 'ERROR');
    throw error;
  }
};

// Get TUS upload endpoint
const getTusEndpoint = async () => {
  try {
    const response = await axios.get(`${CONFIG.STREAM_UPLOAD_BASE}/upload`, {
      headers: { 'api-token': getApiKey() }
    });
    return response.data;
  } catch (error) {
    log(`Get TUS endpoint failed: ${error.message}`, 'ERROR');
    throw error;
  }
};

// FIXED: Stream matching endpoint
app.get('/api/stream/match', async (req, res) => {
  try {
    const { slug, tmdbId } = req.query;
    if (!slug) {
      return res.status(400).json({ error: 'Missing slug parameter' });
    }

    const { title, season, episode } = parseSlug(slug);
    
    log(`Stream match request: "${slug}" → "${title}" S${season || 'null'}E${episode || 'null'}, TMDB: ${tmdbId}`);

    // Search using a simplified version of the title for broader results
    const searchTitle = title.split(' ')[0];
    const allVideos = await searchAllVideos(searchTitle);
    const normalizedRequestTitle = normalizeTitle(title);

    const match = allVideos.find(item => {
      const filename = item.name;
      const { season: fileSeason, episode: fileEpisode } = extractSeasonEpisode(filename);
      
      // Priority 1: Exact TMDB ID match
      if (tmdbId && filename.includes(`{${tmdbId}}`)) {
        if (season && episode) { // For series, also match season and episode
            const seasonMatch = fileSeason && season === fileSeason.toString().padStart(2, '0');
            const episodeMatch = episode && fileEpisode && episode === fileEpisode.toString().padStart(2, '0');
            return seasonMatch && episodeMatch;
        }
        return true; // For movies, TMDB ID is enough
      }

      // Priority 2: Normalized title match
      const fileInfo = parseVideoTitle(filename);
      const normalizedFileTitle = normalizeTitle(fileInfo.title);
      
      const titleMatch = normalizedFileTitle === normalizedRequestTitle;

      if (titleMatch) {
         if (season && episode) { // For series
            const seasonMatch = fileSeason && season === fileSeason.toString().padStart(2, '0');
            const episodeMatch = episode && fileEpisode && episode === fileEpisode.toString().padStart(2, '0');
            return seasonMatch && episodeMatch;
         }
         return true; // For movies
      }
      
      return false;
    });

    if (match) {
      const downloadUrl = `https://moonflix.p2pplay.pro/#${match.id}&dl=1`;
      log(`Stream match found: ${match.name}`);
      
      res.json({
        success: true,
        data: [{
          ...match,
          downloadUrl,
          streamUrl: `https://moonflix.p2pplay.pro/#${match.id}`
        }]
      });
    } else {
      log(`No stream match found for: ${slug}`);
      res.json({ success: false, data: [] });
    }

  } catch (error) {
    log(`Stream match error: ${error.message}`, 'ERROR');
    res.status(500).json({ 
      success: false, 
      error: 'Stream matching failed', 
      details: error.message 
    });
  }
});

// FIXED: More robust slug parsing
const parseSlug = (slug = '') => {
  const seasonMatch = slug.match(/\/season-(\d+)/);
  const episodeMatch = slug.match(/\/episode-(\d+)/);
  
  const season = seasonMatch ? seasonMatch[1].padStart(2, '0') : null;
  const episode = episodeMatch ? episodeMatch[1].padStart(2, '0') : null;

  let title = slug;
  if (seasonMatch) {
    title = title.substring(0, seasonMatch.index);
  } else if (episodeMatch) {
    // Handle cases where only episode is present
    title = title.substring(0, episodeMatch.index);
  }
  
  // Remove trailing slashes and replace hyphens
  title = title.replace(/\/$/, '').replace(/-/g, ' ').trim();

  return { title, season, episode };
};


// Upload from URL endpoint
app.post('/api/upload/url', async (req, res) => {
  try {
    const { url, name, folderId = '' } = req.body;

    if (!url || !name) {
      return res.status(400).json({
        success: false,
        error: 'URL and name are required'
      });
    }

    log(`Upload from URL request: ${name} - ${url}`);

    const result = await uploadFromUrl(url, name, folderId);
    
    if (result.success) {
      // Track upload progress
      uploadProgress.uploads.push({
        taskId: result.taskId,
        name,
        url,
        status: 'pending',
        createdAt: new Date().toISOString()
      });

      if (!uploadProgress.taskIds) uploadProgress.taskIds = [];
      uploadProgress.taskIds.push(result.taskId);

      res.json({
        success: true,
        taskId: result.taskId,
        message: 'Upload started successfully'
      });
    }

  } catch (error) {
    log(`Upload from URL error: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Upload failed',
      details: error.message
    });
  }
});

// Get TUS upload endpoint
app.get('/api/upload/tus', async (req, res) => {
  try {
    const tusData = await getTusEndpoint();
    
    res.json({
      success: true,
      data: tusData
    });

  } catch (error) {
    log(`TUS endpoint error: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Failed to get TUS endpoint',
      details: error.message
    });
  }
});

// Content request endpoint (existing)
app.post('/api/request', (req, res) => {
  try {
    const { title, tmdbId, type, season, episode } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!title || !tmdbId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing title or tmdbId' 
      });
    }

    // Anti-spam: 1 request per day per IP per content
    const key = `${ip}-${tmdbId}`;
    const now = Date.now();
    if (ipTracker[key] && now - ipTracker[key] < 24 * 60 * 60 * 1000) {
      return res.status(429).json({ 
        success: false, 
        error: 'Content already requested today' 
      });
    }
    ipTracker[key] = now;

    const data = readData();
    const existing = data.find(d => d.tmdbId === tmdbId);
    
    if (existing) {
      existing.count++;
      existing.lastRequested = new Date().toISOString();
    } else {
      data.push({
        tmdbId,
        title,
        type: type || 'movie',
        season,
        episode,
        count: 1,
        lastRequested: new Date().toISOString(),
        status: 'requested'
      });
    }

    writeData(data);
    log(`Content requested: ${title} (${tmdbId}) from ${ip}`);
    
    res.json({ 
      success: true, 
      message: 'Request recorded successfully' 
    });

  } catch (error) {
    log(`Request error: ${error.message}`, 'ERROR');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process request' 
    });
  }
});

// Enhanced batch rename endpoint with IMDB ID support
app.post('/api/rename/batch', async (req, res) => {
  if (renameProgress.running) {
    return res.status(409).json({ 
      success: false, 
      error: 'Batch rename already in progress' 
    });
  }

  try {
    renameProgress = { running: true, current: 0, total: 0, status: 'Starting enhanced rename...', failures: [] };
    
    res.json({ 
      success: true, 
      message: 'Enhanced batch rename started. Check progress via /api/rename/progress' 
    });

    const videos = await fetchAllVideos();
    renameProgress.total = videos.length;
    renameProgress.status = 'Processing videos...';

    let count = { renamed: 0, skipped: 0, errors: 0 };

    for (const video of videos) {
      renameProgress.current++;
      renameProgress.status = `Processing: ${video.name}`;

      if (/\{\d+\}.*\{tt\d+\}/.test(video.name) || /\{tt\d+\}.*\{\d+\}/.test(video.name)) {
        count.skipped++;
        continue;
      }

      const info = parseVideoTitle(video.name);
      if (!info.title) {
        count.errors++;
        renameProgress.failures.push({ id: video.id, name: video.name, reason: 'Could not parse title' });
        continue;
      }

      try {
        const tmdb = await searchTMDB(info);
        if (!tmdb) {
          count.errors++;
          renameProgress.failures.push({ id: video.id, name: video.name, reason: 'TMDB/IMDB info not found' });
          continue;
        }

        let newName;
        const s = info.season?.toString().padStart(2, '0');
        const e = info.episode?.toString().padStart(2, '0');
        
        const imdbPart = tmdb.imdbId ? ` {${tmdb.imdbId}}` : '';
        if (info.isSeries) {
          newName = `${tmdb.seriesName} S${s}-E${e}-${tmdb.episodeName} {${tmdb.tmdbId}}${imdbPart}.mkv`;
        } else {
          newName = `${tmdb.title} ${tmdb.year} {${tmdb.tmdbId}}${imdbPart}.mkv`;
        }

        const success = await renameVideo(video.id, newName);
        if (success) {
          count.renamed++;
        } else {
          count.errors++;
          renameProgress.failures.push({ id: video.id, name: video.name, reason: 'API rename failed' });
        }
        
      } catch (tmdbError) {
        log(`TMDB/IMDB lookup error for ${video.name}: ${tmdbError.message}`, 'ERROR');
        count.errors++;
        renameProgress.failures.push({ id: video.id, name: video.name, reason: 'TMDB/IMDB API error' });
      }
      
      await delay(200);
    }

    renameProgress.running = false;
    renameProgress.status = `Completed: ${count.renamed} renamed, ${count.skipped} skipped, ${count.errors} errors`;
    log(`Batch rename completed: ${JSON.stringify(count)}`);

  } catch (error) {
    renameProgress.running = false;
    renameProgress.status = `Error: ${error.message}`;
    log(`Batch rename error: ${error.message}`, 'ERROR');
  }
});

// NEW: Manual rename endpoint
app.post('/api/rename/manual', async (req, res) => {
    try {
        const { videoId, newName } = req.body;
        if (!videoId || !newName) {
            return res.status(400).json({ success: false, error: 'videoId and newName are required' });
        }

        const success = await renameVideo(videoId, newName);

        if (success) {
            res.json({ success: true, message: 'Video renamed successfully' });
        } else {
            res.status(500).json({ success: false, error: 'Failed to rename video via API' });
        }
    } catch (error) {
        log(`Manual rename error: ${error.message}`, 'ERROR');
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Rename progress endpoint
app.get('/api/rename/progress', (req, res) => {
  res.json({ success: true, progress: renameProgress });
});

// Dashboard data endpoint
app.get('/api/dashboard/data', (req, res) => {
  try {
    const data = readData();
    const stats = {
      totalRequests: data.length,
      totalCount: data.reduce((sum, item) => sum + item.count, 0),
      movieRequests: data.filter(item => item.type === 'movie').length,
      seriesRequests: data.filter(item => item.type === 'tv' || item.type === 'series').length
    };

    res.json({
      success: true,
      data: data.sort((a, b) => b.count - a.count),
      stats
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch dashboard data' 
    });
  }
});

// NEW: Delete single request endpoint
app.delete('/api/requests/:tmdbId', (req, res) => {
    try {
        const { tmdbId } = req.params;
        let data = readData();
        const initialLength = data.length;
        data = data.filter(item => item.tmdbId.toString() !== tmdbId.toString());

        if (data.length < initialLength) {
            writeData(data);
            log(`Request deleted: TMDB ID ${tmdbId}`);
            res.json({ success: true, message: 'Request deleted successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Request not found' });
        }
    } catch (error) {
        log(`Delete request error: ${error.message}`, 'ERROR');
        res.status(500).json({ success: false, error: 'Failed to delete request' });
    }
});

// Clear requests endpoint
app.delete('/api/requests/clear', (req, res) => {
  try {
    writeData([]);
    log('All requests cleared');
    res.json({ success: true, message: 'All requests cleared' });
  } catch (error) {
    log(`Clear requests error: ${error.message}`, 'ERROR');
    res.status(500).json({ success: false, error: 'Failed to clear requests' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '2.1.0-professional'
  });
});

// Server status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    server: 'StreamP2P Manager Professional',
    version: '2.1.0-professional',
    uptime: process.uptime(),
    features: [
      '🔍 Advanced Video Search with Episode Organization',
      '📤 Enhanced URL/Torrent Upload with Status Tracking',
      '📝 Optimized Batch Upload Support',
      '🔄 Duplicate Detection & Management',
      '🏷️ Auto Video Renaming with TMDB & IMDB Integration',
      '📊 Comprehensive Analytics Dashboard',
      '🎬 Enhanced Title Parsing (Multiple Formats)',
      '🆔 IMDB ID Integration for Movies & TV Shows',
      '🔁 Single & Batch Video Cloning',
      '🗑️ Single Request Deletion from Dashboard',
      '🛠️ Manual Rename for Failed Items'
    ],
    endpoints: {
      'GET /': 'Server status',
      'GET /health': 'Health check',
      'GET /dashboard': 'Management dashboard',
      'GET /api/stream/search': 'Search all videos (with organize option)',
      'GET /api/stream/match': 'Find stream by slug (FIXED)',
      'POST /api/request': 'Submit content request',
      'POST /api/upload/url': 'Upload from URL/torrent',
      'POST /api/upload/batch': 'Batch upload from URLs',
      'GET /api/upload/tus': 'Get TUS upload endpoint',
      'GET /api/upload/status/:taskId': 'Check upload status',
      'GET /api/upload/progress': 'Upload progress with task statuses',
      'GET /api/duplicates/scan': 'Scan for duplicate videos',
      'GET /api/duplicates/progress': 'Duplicate scan progress',
      'DELETE /api/duplicates/delete/:videoId': 'Delete specific video',
      'POST /api/duplicates/batch-delete': 'Batch delete videos',
      'POST /api/rename/batch': 'Start enhanced batch rename (TMDB + IMDB)',
      'POST /api/rename/manual': 'Manually rename a single video (NEW)',
      'GET /api/rename/progress': 'Rename progress',
      'POST /api/video/clone': 'Clone a single video',
      'POST /api/video/clone/batch': 'Clone multiple videos',
      'GET /api/dashboard/data': 'Dashboard data',
      'DELETE /api/requests/clear': 'Clear all requests',
      'DELETE /api/requests/:tmdbId': 'Delete a single request (NEW)'
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: '🎬 StreamP2P Manager Server v2.1 Professional',
    version: '2.1.0-professional',
    status: 'Running',
    newFeatures: [
      '🎯 Fixed stream matching for titles with special characters',
      '🗑️ Added single request deletion from the dashboard',
      '🛠️ Added manual rename interface for failed batch renames'
    ]
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  log(`Unhandled error: ${error.message}`, 'ERROR');
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('StreamP2P Manager shutting down gracefully...');
  if (progressInterval) clearInterval(progressInterval);
  if (uploadInterval) clearInterval(uploadInterval);
  if (duplicateInterval) clearInterval(duplicateInterval);
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'ERROR');
});

process.on('uncaughtException', (error) => {
  log(`Uncaught Exception: ${error.message}`, 'ERROR');
  process.exit(1);
});

// Start server
app.listen(PORT, () => {
  log(`🚀 StreamP2P Manager v2.1 Professional running on http://localhost:${PORT}`);
  log(`📊 Dashboard: http://localhost:${PORT}/dashboard?pass=${CONFIG.DASHBOARD_PASSWORD}`);
  log(`🔧 API Status: http://localhost:${PORT}/api/status`);
  log(`✨ NEW Features & Fixes:`);
  log(`   🎯 FIXED: Stream matching for titles like 'Ginny & Georgia'`);
  log(`   🗑️ NEW: Delete single requests directly from the dashboard`);
  log(`   🛠️ NEW: Manually correct and rename files that failed the batch process`);
  log(`🎉 Your professional media management server is ready!`);
});
