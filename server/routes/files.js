const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { ensureSetup } = require('../middleware/setup');
const storage = require('../services/storage');
const metadata = require('../services/metadata');
const streaming = require('../services/streaming');
const { recordBytes } = require('../services/bandwidth');
const hlsStream = require('../services/hls-stream');
const tasks = require('../services/tasks');
const hlsConvert = require('../services/hls-convert');
const seamlessUpload = require('../services/seamless-upload');
const { REPO_CAPACITY_BYTES } = require('../services/capacity');
const logger = require('../lib/logger');
const audit = require('../services/audit');
const contentHash = require('../services/content-hash');

function auditMeta(req, meta = {}) {
  return {
    ip: req.ip || req.connection?.remoteAddress,
    ...meta,
  };
}

const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 * 1024 } });
const chunkUpload = multer({ dest: uploadDir, limits: { fileSize: 100 * 1024 * 1024 } });
const seamlessPartUpload = multer({ dest: uploadDir, limits: { fileSize: 32 * 1024 * 1024 } });
const thumbUpload = multer({ dest: uploadDir, limits: { fileSize: 8 * 1024 * 1024, files: 50 } });
const router = express.Router();

const viewMode = require('../services/view-mode');
const downloadSession = require('../services/download-session');

function formatFeedbackBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function getStorageFeedback(userId, plan = null, task = null) {
  const repos = db.prepare(`
    SELECT id, full_name, is_active, is_metadata,
      COALESCE(total_bytes, 0) as total_bytes,
      COALESCE(reserved_bytes, 0) as reserved_bytes
    FROM storage_repos
    WHERE user_id = ? AND is_metadata = 0
  `).all(userId);
  const capacitySvc = require('../services/capacity');
  const active = repos.filter(r => r.is_active);
  const available = active.filter(
    (r) => capacitySvc.getRepoEffectiveBytes(r) < REPO_CAPACITY_BYTES
  );
  const usedBytes = active.reduce((sum, r) => sum + capacitySvc.getRepoEffectiveBytes(r), 0);
  const capacityBytes = active.length * REPO_CAPACITY_BYTES;
  const availableBytes = Math.max(0, capacityBytes - usedBytes);
  const warnings = [];
  if (active.length === 0) warnings.push('No active storage repositories configured.');
  if (active.length > 0 && available.length === 0) warnings.push('All active storage repositories are full.');
  if (plan?.needsConfig) warnings.push('Storage repositories must be configured before upload.');
  if (plan?.allFull) warnings.push('Storage pool is full. Add storage or delete files before upload.');
  if (plan?.insufficientSpace) {
    warnings.push(
      plan.convertHls
        ? `Not enough space for the encrypted file and HLS segments (need ${formatFeedbackBytes(plan.totalStorageBytes)}, `
          + `${formatFeedbackBytes(plan.storageAvailableBytes)} free).`
        : `Not enough space for this upload (need ${formatFeedbackBytes(plan.totalStorageBytes)}, `
          + `${formatFeedbackBytes(plan.storageAvailableBytes)} free).`
    );
  }
  return {
    task: task ? {
      id: task.id,
      status: task.status,
      phase: task.phase,
      percent: task.percent,
      chunksDone: task.chunksDone || task.chunks_done || 0,
      chunksTotal: task.chunksTotal || task.chunks_total || 0,
      error: task.error || null,
    } : null,
    storage: {
      repoCount: repos.length,
      activeRepoCount: active.length,
      availableRepoCount: available.length,
      capacityBytes,
      usedBytes,
      availableBytes,
      usedPercent: capacityBytes > 0 ? Math.round((usedBytes / capacityBytes) * 1000) / 10 : 0,
      poolFull: active.length > 0 && available.length === 0,
      warnings,
    },
  };
}

router.get('/download/:id', async (req, res) => {
  try {
    const view = viewMode.parseViewParam(req.query.view);
    const sessionId = req.query.session;
    const authToken = req.query.auth;

    if (sessionId && authToken) {
      const session = downloadSession.validate(sessionId, authToken);
      if (!session || session.fileId !== req.params.id) {
        return res.status(404).json({ error: 'Download session not found or expired' });
      }
      if (session.error) return res.status(500).json({ error: session.error });
      if (!session.ready || !session.buffer) {
        return res.status(202).json(downloadSession.toStatus(session));
      }

      const { file } = session;
      return downloadSession.sendPreparedFile(res, session, file?.mime_type, file?.name);
    }

    const db = require('../db/database');
    const fileRec = db.prepare('SELECT id, user_id FROM files WHERE id = ?').get(req.params.id);
    if (!fileRec) return res.status(404).json({ error: 'File not found' });

    const { buffer, file } = await storage.downloadFile(fileRec.user_id, req.params.id, view);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
    recordBytes(fileRec.user_id, file.id, buffer.length, 'download');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const db = require('../db/database');

router.get('/thumbnail/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const fileRec = db.prepare('SELECT id, user_id, has_thumbnail FROM files WHERE id = ?').get(fileId);
    if (!fileRec) return res.status(404).end();
    const userId = fileRec.user_id;
    const thumbCache = require('../services/thumb-cache');

    let thumb = thumbCache.get(userId, fileId);
    if (!thumb) {
      const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
      if (!file) return res.status(404).end();
      if (file.has_thumbnail) {
        thumb = await metadata.getThumbnail(userId, fileId);
      } else {
        thumb = await storage.getShareThumbnail(file);
      }
    }
    if (!thumb) return res.status(404).end();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(thumb);
  } catch {
    res.status(404).end();
  }
});

router.get('/view/:id', async (req, res) => {
  try {
    const view = viewMode.parseViewParam(req.query.view);
    const fileRec = db.prepare('SELECT id, user_id FROM files WHERE id = ?').get(req.params.id);
    if (!fileRec) return res.status(404).json({ error: 'File not found' });
    await streaming.streamFile(req, res, fileRec.user_id, req.params.id, view);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get('/stream/:id', async (req, res) => {
  try {
    const view = viewMode.parseViewParam(req.query.view);
    const fileRec = db.prepare('SELECT id, user_id FROM files WHERE id = ?').get(req.params.id);
    if (!fileRec) return res.status(404).json({ error: 'File not found' });
    const userId = fileRec.user_id;
    const fileId = req.params.id;
    res.on('finish', () => {
      const len = parseInt(res.getHeader('Content-Length') || '0', 10);
      if (len > 0) recordBytes(userId, fileId, len, 'stream');
    });
    await streaming.streamFile(req, res, userId, fileId, view);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get('/status/:id', (req, res) => {
  try {
    const fileRec = db.prepare('SELECT id, user_id FROM files WHERE id = ?').get(req.params.id);
    if (!fileRec) return res.status(404).json({ error: 'File not found' });
    res.json(streaming.getStatus(fileRec.user_id, req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/hls/:id/playlist.m3u8', async (req, res) => {
  try {
    const view = viewMode.parseViewParam(req.query.view);
    const base = `/api/files/hls/${req.params.id}`;
    const fileRec = db.prepare('SELECT id, user_id, name FROM files WHERE id = ?').get(req.params.id);
    if (!fileRec) return res.status(404).send('#EXTM3U\n# File not found\n');
    const baseName = (fileRec.name || 'media').replace(/\.[^.]+$/, '');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(baseName)}.m3u8"`);
    await hlsStream.servePlaylist(req, res, fileRec.user_id, req.params.id, base, view);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get('/hls/:id/uploaded/playlist.m3u8', async (req, res) => {
  try {
    const view = viewMode.parseViewParam(req.query.view);
    const fileRec = db.prepare('SELECT id, user_id, name, has_hls, hls_playlist_repo_id, hls_playlist_path FROM files WHERE id = ?').get(req.params.id);
    if (!fileRec) return res.status(404).send('#EXTM3U\n# File not found\n');
    if (!fileRec.has_hls || !fileRec.hls_playlist_repo_id || !fileRec.hls_playlist_path) {
      return res.status(404).send('#EXTM3U\n# HLS not available for this file\n');
    }
    const baseName = (fileRec.name || 'media').replace(/\.[^.]+$/, '');
    const repo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(fileRec.hls_playlist_repo_id);
    if (!repo) return res.status(404).send('#EXTM3U\n# Playlist repo not found\n');
    const { githubRawUrl } = require('../services/storage');
    const playlistUrl = githubRawUrl(repo.full_name, repo.default_branch, fileRec.hls_playlist_path);
    const resp = await fetch(playlistUrl);
    if (!resp.ok) return res.status(502).send('#EXTM3U\n# Failed to fetch uploaded playlist\n');
    const body = await resp.text();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(baseName)}.m3u8"`);
    res.send(Buffer.from(body, 'utf8'));
    recordBytes(fileRec.user_id, req.params.id, Buffer.byteLength(body, 'utf-8'), 'stream');
  } catch (err) {
    console.error('[uploaded playlist]', err.message, err.stack?.split('\n').slice(1, 4).join(' '));
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get('/hls/:id/github-playlist', async (req, res) => {
  try {
    const fileRec = db.prepare('SELECT id, name, has_hls, hls_playlist_repo_id, hls_playlist_path FROM files WHERE id = ?').get(req.params.id);
    if (!fileRec || !fileRec.has_hls || !fileRec.hls_playlist_repo_id || !fileRec.hls_playlist_path) {
      return res.status(404).json({ error: 'HLS playlist not available' });
    }
    const repo = db.prepare('SELECT full_name, default_branch FROM storage_repos WHERE id = ?').get(fileRec.hls_playlist_repo_id);
    if (!repo) return res.status(404).json({ error: 'Repo not found' });
    const rawUrl = `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${fileRec.hls_playlist_path}`;
    res.json({ url: rawUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/hls/:id/segment/:index.ts', async (req, res) => {
  try {
    const view = viewMode.parseViewParam(req.query.view);
    const fileRec = db.prepare('SELECT id, user_id FROM files WHERE id = ?').get(req.params.id);
    if (!fileRec) return res.status(404).send('File not found');
    await hlsStream.serveSegment(req, res, fileRec.user_id, req.params.id, req.params.index, view);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.use(requireAuth, ensureSetup);

router.get('/list', (req, res) => {
  try {
    const parentPath = req.query.path || '/';
    const view = viewMode.parseViewParam(req.query.view);
    const opts = {
      search: req.query.search || null,
      sort: req.query.sort || 'name',
      order: req.query.order === 'desc' ? 'DESC' : 'ASC',
      type: req.query.type || null,
      limit: req.query.limit || null,
      offset: req.query.offset || 0,
    };
    const result = storage.listFiles(req.user.id, parentPath, view, opts);
    res.json({
      files: result.files,
      total: result.total,
      hasMore: result.hasMore,
      nextOffset: result.nextOffset,
      path: parentPath,
      view: req.query.view || 'primary',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/folders', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT parent_path FROM files
      WHERE user_id = ? AND is_folder = 0 AND (upload_status IS NULL OR upload_status = 'ready')
      UNION
      SELECT path FROM files
      WHERE user_id = ? AND is_folder = 1
      ORDER BY parent_path
    `).all(req.user.id, req.user.id);
    const paths = [...new Set(rows.map(r => r.parent_path || r.path || '/'))];
    res.json({ folders: paths });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/plan', (req, res) => {
  try {
    const { size, chunkSize, contentHash: hash, convertHls, mimeType, fileName } = req.body;
    if (!size) return res.status(400).json({ error: 'size required' });
    const plan = storage.planUpload(
      parseInt(size, 10),
      parseInt(chunkSize, 10) || storage.CHUNK_SIZE,
      req.user.id,
      {
        convertHls: !!(convertHls && (mimeType?.startsWith('video/') || /\.mp4$/i.test(fileName || ''))),
        mimeType: mimeType || null,
        fileName: fileName || null,
      }
    );
    const duplicate = hash ? contentHash.findDuplicate(req.user.id, hash) : null;
    res.json({
      ...plan,
      duplicate: duplicate ? { id: duplicate.id, name: duplicate.name, path: duplicate.path, size: duplicate.size, created_at: duplicate.created_at } : null,
      feedback: getStorageFeedback(req.user.id, plan),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const jobId = uuidv4();
  const parentPath = req.body.path || '/';
  let chunkSize;
  try {
    chunkSize = storage.normalizeChunkSize(parseInt(req.body.chunkSize, 10) || storage.CHUNK_SIZE);
  } catch (err) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: err.message });
  }
  const buffer = fs.readFileSync(req.file.path);
  fs.unlinkSync(req.file.path);

  tasks.create(req.user.id, {
    id: jobId,
    type: 'upload',
    title: req.file.originalname,
    payload: { fileName: req.file.originalname },
  });

  storage.uploadFile(
    req.user.id,
    req.file.originalname,
    parentPath,
    buffer,
    req.file.mimetype,
    {
      chunkSize,
      onProgress: (p) => tasks.update(jobId, req.user.id, { ...p, status: 'processing' }),
    }
  ).then((result) => {
    tasks.update(jobId, req.user.id, {
      status: 'done', percent: 100, file: result, phase: 'done',
    });
  }).catch((err) => {
    tasks.update(jobId, req.user.id, { status: 'error', error: err.message });
  });

  const plan = storage.planUpload(buffer.length, chunkSize, req.user.id);
  res.json({
    jobId,
    fileName: req.file.originalname,
    estimatedChunks: plan.totalChunks,
    feedback: getStorageFeedback(req.user.id, plan, tasks.get(jobId, req.user.id)),
  });
});

router.get('/upload-progress/:jobId', (req, res) => {
  const job = tasks.get(req.params.jobId, req.user.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.post('/upload/init', async (req, res) => {
  try {
    const {
      fileName, path, parentPath: parentPathField, size, mimeType, chunkSize, fileId, taskId,
    } = req.body;
    const parentPath = parentPathField || path || '/';
    if (!fileName || !size) return res.status(400).json({ error: 'fileName and size required' });

    const jobId = taskId || uuidv4();
    const existingTask = taskId ? tasks.get(taskId, req.user.id) : null;

    if (existingTask) {
      tasks.update(jobId, req.user.id, {
        status: 'processing',
        phase: 'starting',
        error: null,
        title: fileName,
      });
    } else {
      tasks.create(req.user.id, {
        id: jobId,
        type: 'upload',
        title: fileName,
        payload: { fileName, resumable: true },
      });
    }

    const uploadMode = req.body.uploadMode === 'git' ? 'git' : 'api';
    const convertHls = !!(
      req.body.convertHls
      && (mimeType?.startsWith('video/') || /\.mp4$/i.test(fileName || ''))
    );

    const session = await storage.initUploadSession(req.user.id, {
      fileName,
      parentPath: parentPath || '/',
      size: parseInt(size, 10),
      mimeType,
      chunkSize: parseInt(chunkSize, 10) || storage.CHUNK_SIZE,
      fileId,
      convertHls,
    });
    if (convertHls) {
      const ffmpegOk = await hlsConvert.isFfmpegAvailable();
      if (!ffmpegOk) {
        tasks.update(jobId, req.user.id, { status: 'error', error: 'FFmpeg not available for HLS conversion' });
        return res.status(400).json({ error: 'HLS conversion requires FFmpeg on the server' });
      }
    }
    tasks.update(jobId, req.user.id, {
      status: 'processing',
      phase: session.nextChunk >= session.totalChunks ? 'metadata' : 'upload',
      chunksTotal: session.totalChunks,
      chunksDone: session.chunksDone,
      percent: session.percent,
      fileId: session.fileId,
      parentPath: parentPath || '/',
      chunkSize: session.chunkSize,
      fileSize: parseInt(size, 10),
      mimeType: mimeType || 'application/octet-stream',
      resumable: true,
      nextChunk: session.nextChunk,
      uploadMode,
      convertHls,
    });
    const resumeMsg = session.chunksDone > 0
      ? `Resuming — ${session.chunksDone}/${session.totalChunks} chunks already stored, starting at chunk ${session.nextChunk}`
      : `Upload started — ${session.totalChunks} chunks to upload`;
    tasks.appendLog(jobId, req.user.id, resumeMsg, {
      chunksDone: session.chunksDone,
      totalChunks: session.totalChunks,
      nextChunk: session.nextChunk,
    });

    res.json({
      ...session,
      jobId,
      uploadMode,
      feedback: getStorageFeedback(req.user.id, null, tasks.get(jobId, req.user.id)),
    });
  } catch (err) {
    logger.warn('upload_init_failed', {
      userId: req.user.id, fileName: req.body?.fileName, error: err.message,
    });
    res.status(400).json({ error: err.message });
  }
});

router.post('/upload/chunk', chunkUpload.single('chunk'), async (req, res) => {
  const taskId = req.body.taskId;
  const fileId = req.body.fileId;
  const chunkIndex = parseInt(req.body.chunkIndex, 10);
  try {
    if (!req.file) return res.status(400).json({ error: 'No chunk provided' });
    if (!fileId) return res.status(400).json({ error: 'fileId required' });

    const buffer = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);

    if (taskId) {
      const existing = tasks.get(taskId, req.user.id);
      if (existing?.status === 'paused') {
        return res.status(409).json({ error: 'Upload is paused — click Resume to continue' });
      }
    }

    const uploadMode = req.body.uploadMode === 'git' ? 'git' : 'api';

    if (taskId) {
      tasks.appendLog(taskId, req.user.id, `Uploading chunk ${chunkIndex} to primary...`, { chunkIndex });
      tasks.update(taskId, req.user.id, {
        status: 'processing',
        phase: 'upload',
        pauseReason: null,
        error: null,
        resumable: true,
      });
    }

    const result = await storage.uploadPlainChunk(
      req.user.id,
      fileId,
      chunkIndex,
      buffer,
      uploadMode,
      taskId ? { taskId, userId: req.user.id } : null
    );

    if (taskId) {
      const patch = {
        status: 'processing',
        phase: 'upload',
        chunksDone: result.chunksDone,
        chunksTotal: result.totalChunks,
        percent: result.percent,
        currentRepo: result.currentRepo || null,
        fileId,
        resumable: true,
        nextChunk: result.nextChunk,
        uploadMode,
      };
      if (uploadMode === 'git' && !result.skipped) {
        const existing = tasks.get(taskId, req.user.id);
        const repos = new Set(existing?.gitRepos || []);
        if (result.currentRepo) repos.add(result.currentRepo);
        patch.gitRepos = [...repos];
        patch.gitBytesStaged = (existing?.gitBytesStaged || 0) + buffer.length;
      }
      if (!result.skipped) {
        tasks.appendLog(
          taskId,
          req.user.id,
          `Stored chunk ${chunkIndex} on primary${uploadMode === 'git' ? '' : ' (backup sync will mirror later)'}`,
          { chunkIndex, repo: result.currentRepo }
        );
      }
      tasks.update(taskId, req.user.id, patch);
    }

    res.json({
      ...result,
      feedback: getStorageFeedback(req.user.id, null, taskId ? tasks.get(taskId, req.user.id) : null),
    });
  } catch (err) {
    logger.error('chunk_upload_failed', {
      userId: req.user.id, fileId, chunkIndex, taskId, error: err.message,
    });
    if (taskId) {
      tasks.update(taskId, req.user.id, { status: 'error', error: err.message, resumable: true });
      tasks.appendLog(taskId, req.user.id, `Chunk ${chunkIndex} failed: ${err.message}`);
    }
    // Only mark as failed for permanent errors; transient errors let the client retry
    const permanentErrors = ['Invalid chunk index', 'User not found', 'Chunk blob is', 'No storage'];
    const isPermanent = permanentErrors.some(p => err.message.startsWith(p));
    if (fileId && isPermanent) storage.markUploadFailed(req.user.id, fileId);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload/complete', chunkUpload.single('preview'), async (req, res) => {
  const { fileId, taskId } = req.body;
  try {
    if (!fileId) return res.status(400).json({ error: 'fileId required' });

    let preview = null;
    if (req.file) {
      preview = fs.readFileSync(req.file.path);
      fs.unlinkSync(req.file.path);
    }

    const uploadMode = req.body.uploadMode === 'git' ? 'git' : 'api';
    const result = await storage.finalizeUpload(
      req.user.id,
      fileId,
      preview,
      (p) => {
        if (!taskId) return;
        tasks.update(taskId, req.user.id, { ...p, status: 'processing', fileId, resumable: true });
        if (p.lastLog) tasks.appendLog(taskId, req.user.id, p.lastLog);
      },
      uploadMode,
      taskId ? { taskId, userId: req.user.id } : null
    );

    audit.log(req.user.id, 'upload_complete', {
      targetType: 'file', targetId: result.id, targetName: result.name,
      details: JSON.stringify({ size: result.size, chunks: result.chunks, mode: uploadMode }),
      ip: req.ip,
    });

    if (req.body.contentHash) {
      contentHash.storeHash(result.id, req.body.contentHash);
    }

    const rawConvertHls = req.body.convertHls;
    const convertHls = rawConvertHls === '1' || rawConvertHls === true || rawConvertHls === 'true';
    const isMp4 = /^video\//.test(result.mime_type) || /\.mp4$/i.test(result.name || '');
    let hlsTaskId = null;

    console.log(`[upload/complete] convertHls=${convertHls} raw=${JSON.stringify(rawConvertHls)} isMp4=${isMp4} taskId=${!!taskId} name=${result.name}`);

    if (taskId) {
      tasks.update(taskId, req.user.id, {
        status: 'done',
        percent: 100,
        phase: 'done',
        file: result,
        resumable: false,
      });
    }

    if (convertHls && isMp4) {
      hlsTaskId = uuidv4();
      console.log(`[upload/complete] Starting HLS conversion task ${hlsTaskId} for ${fileId}`);
      tasks.create(req.user.id, {
        id: hlsTaskId,
        type: 'hls-convert',
        title: `Converting ${result.name} to HLS...`,
        payload: { fileId, fileName: result.name, uploadTaskId: taskId || null },
      });
      tasks.update(hlsTaskId, req.user.id, {
        status: 'processing',
        phase: 'assembling',
        percent: 2,
        lastLog: 'Queued HLS conversion after upload',
      });
      hlsConvert.convertFile(req.user.id, fileId, (p) => {
        updateHlsTaskProgress(hlsTaskId, req.user.id, p);
      }, hlsTaskId).then((hlsResult) => {
        console.log(`[upload/complete] HLS conversion succeeded for ${fileId}: ${hlsResult.segments} segments, playlist at ${hlsResult.playlist}`);
        if (isHlsTaskCancelled(hlsTaskId, req.user.id)) return;
        tasks.update(hlsTaskId, req.user.id, {
          status: 'done',
          percent: 100,
          phase: 'done',
          file: { ...result, hls: hlsResult },
        });
      }).catch((err) => {
        console.error(`[upload/complete] HLS conversion failed: ${err.message}`, err.stack?.split('\n').slice(0, 3).join('\n'));
        if (isHlsTaskCancelled(hlsTaskId, req.user.id)) return;
        if (err.message === 'Cancelled') return;
        tasks.appendLog(hlsTaskId, req.user.id, `HLS conversion failed: ${err.message}`);
        tasks.update(hlsTaskId, req.user.id, {
          status: 'error',
          error: err.message,
          resumable: false,
        });
      });
    }

    res.json({
      ...result,
      hlsTaskId,
      feedback: getStorageFeedback(req.user.id, null, taskId ? tasks.get(taskId, req.user.id) : null),
    });
  } catch (err) {
    logger.error('upload_complete_failed', {
      userId: req.user.id, fileId, taskId, error: err.message,
    });
    if (taskId) {
      tasks.update(taskId, req.user.id, { status: 'error', error: err.message, resumable: true });
    }
    if (fileId) storage.markUploadFailed(req.user.id, fileId);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

router.get('/upload/session/:fileId', (req, res) => {
  try {
    const session = storage.getUploadSession(req.user.id, req.params.fileId);
    if (!session) return res.status(404).json({ error: 'Upload session not found' });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/upload/session/:fileId/chunks', (req, res) => {
  try {
    const indices = storage.getUploadedChunkIndices(req.params.fileId);
    res.json({ fileId: req.params.fileId, indices, count: indices.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload/seamless/init', async (req, res) => {
  try {
    const {
      fileName, path, parentPath: parentPathField, size, mimeType, chunkSize, fileId, taskId,
    } = req.body;
    const parentPath = parentPathField || path || '/';
    if (!fileName || !size) return res.status(400).json({ error: 'fileName and size required' });

    const convertHls = !!(
      req.body.convertHls
      && (mimeType?.startsWith('video/') || /\.mp4$/i.test(fileName || ''))
    );
    if (convertHls) {
      const ffmpegOk = await hlsConvert.isFfmpegAvailable();
      if (!ffmpegOk) {
        return res.status(400).json({ error: 'HLS conversion requires FFmpeg on the server' });
      }
    }

    const session = await seamlessUpload.initSeamlessUpload(req.user.id, {
      fileName,
      parentPath,
      size: parseInt(size, 10),
      mimeType,
      chunkSize: parseInt(chunkSize, 10) || storage.CHUNK_SIZE,
      fileId,
      convertHls,
      taskId,
    });

    res.json({
      ...session,
      feedback: getStorageFeedback(req.user.id, null, tasks.get(session.jobId, req.user.id)),
    });
  } catch (err) {
    logger.warn('seamless_init_failed', { userId: req.user.id, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.post('/upload/seamless/part', seamlessPartUpload.single('part'), async (req, res) => {
  const taskId = req.body.taskId;
  const fileId = req.body.fileId;
  const partIndex = parseInt(req.body.partIndex, 10);
  try {
    if (!req.file) return res.status(400).json({ error: 'No part provided' });
    if (!fileId) return res.status(400).json({ error: 'fileId required' });

    const buffer = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);

    if (taskId) {
      const existing = tasks.get(taskId, req.user.id);
      if (existing?.status === 'paused') {
        return res.status(409).json({ error: 'Upload is paused' });
      }
    }

    const result = await seamlessUpload.writeSeamlessPart(
      req.user.id,
      fileId,
      partIndex,
      buffer,
      taskId
    );

    res.json({
      ...result,
      feedback: getStorageFeedback(req.user.id, null, taskId ? tasks.get(taskId, req.user.id) : null),
    });
  } catch (err) {
    logger.error('seamless_part_failed', {
      userId: req.user.id, fileId, partIndex, taskId, error: err.message,
    });
    if (taskId) {
      tasks.update(taskId, req.user.id, { status: 'error', error: err.message, resumable: true });
      tasks.appendLog(taskId, req.user.id, `Part ${partIndex} failed: ${err.message}`);
    }
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload/seamless/complete', async (req, res) => {
  const { fileId, taskId } = req.body;
  try {
    if (!fileId) return res.status(400).json({ error: 'fileId required' });
    const convertHls = req.body.convertHls === '1' || req.body.convertHls === true || req.body.convertHls === 'true';
    const result = await seamlessUpload.completeSeamlessReceive(
      req.user.id,
      fileId,
      taskId,
      { convertHls }
    );
    res.json(result);
  } catch (err) {
    logger.error('seamless_complete_failed', {
      userId: req.user.id, fileId, taskId, error: err.message,
    });
    if (taskId) {
      tasks.update(taskId, req.user.id, { status: 'error', error: err.message, resumable: true });
      tasks.appendLog(taskId, req.user.id, `Seamless complete failed: ${err.message}`);
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/upload/seamless/status/:fileId', (req, res) => {
  try {
    const status = seamlessUpload.getSeamlessStatus(req.user.id, req.params.fileId);
    if (!status) return res.status(404).json({ error: 'Seamless upload not found' });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload/seamless/resume', async (req, res) => {
  const { fileId, taskId } = req.body;
  try {
    if (!fileId) return res.status(400).json({ error: 'fileId required' });
    const status = seamlessUpload.getSeamlessStatus(req.user.id, fileId);
    if (!status) return res.status(404).json({ error: 'Seamless upload not found' });
    if (!status.stagingComplete) {
      return res.status(400).json({
        error: 'File not fully cached on server yet',
        missingParts: status.missingParts,
      });
    }
    const convertHls = req.body.convertHls === '1' || req.body.convertHls === true || req.body.convertHls === 'true';
    const result = await seamlessUpload.completeSeamlessReceive(
      req.user.id,
      fileId,
      taskId || status.taskId,
      { convertHls }
    );
    res.json(result);
  } catch (err) {
    logger.error('seamless_resume_failed', {
      userId: req.user.id, fileId, taskId, error: err.message,
    });
    if (taskId) {
      tasks.update(taskId, req.user.id, { status: 'error', error: err.message, resumable: true });
      tasks.appendLog(taskId, req.user.id, `Seamless resume failed: ${err.message}`);
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload/cancel', async (req, res) => {
  try {
    const { fileId, taskId } = req.body;
    if (fileId) {
      await storage.cancelUploadSession(req.user.id, fileId);
    }
    if (taskId) {
      await tasks.cancelTask(taskId, req.user.id);
    } else if (!fileId) {
      return res.status(400).json({ error: 'taskId or fileId required' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/delete-batch', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'No items selected' });

    const db = require('../db/database');
    const names = ids.map((id) => {
      const file = db.prepare('SELECT name FROM files WHERE id = ? AND user_id = ?').get(id, req.user.id);
      return file?.name || 'item';
    });

    const taskId = require('uuid').v4();
    const title = ids.length === 1
      ? `Deleting ${names[0]}`
      : `Deleting ${ids.length} items`;

    tasks.create(req.user.id, {
      id: taskId,
      type: 'delete',
      title,
      payload: { ids, names, done: 0, total: ids.length },
    });

    (async () => {
      try {
        for (let i = 0; i < ids.length; i++) {
          tasks.update(taskId, req.user.id, {
            status: 'processing',
            phase: 'delete',
            percent: Math.round((i / ids.length) * 100),
            title: ids.length === 1
              ? `Deleting ${names[i]}`
              : `Deleting ${names[i]} (${i + 1}/${ids.length})`,
            done: i,
            total: ids.length,
            currentName: names[i],
            error: null,
          });
          const deletePromise = storage.deleteFile(req.user.id, ids[i]);
          const timeout = new Promise(resolve => setTimeout(resolve, 60000));
          await Promise.race([deletePromise, timeout]);
        }
        tasks.update(taskId, req.user.id, {
          status: 'done',
          phase: 'done',
          percent: 100,
          done: ids.length,
          total: ids.length,
          error: null,
          resumable: false,
        });
      } catch (err) {
        tasks.update(taskId, req.user.id, { status: 'error', error: err.message });
      }
    })();

    res.json({ taskId, count: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/details/:id', (req, res) => {
  try {
    res.json(storage.getFileDetails(req.user.id, req.params.id, req));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/share/:id', (req, res) => {
  try {
    res.json(storage.createShareToken(req.user.id, req.params.id, req));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/share/settings', (req, res) => {
  try {
    res.json({
      client_stream: storage.getShareClientStreamEnabled(req.user.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/share/settings', (req, res) => {
  try {
    const enabled = !!req.body?.client_stream;
    res.json(storage.setShareClientStreamEnabled(req.user.id, enabled));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/share/:id', (req, res) => {
  try {
    storage.revokeShareToken(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function updateHlsTaskProgress(taskId, userId, patch) {
  if (!taskId) return;
  tasks.update(taskId, userId, { ...patch, status: 'processing' });
  if (patch.lastLog) tasks.appendLog(taskId, userId, patch.lastLog);
}

function isHlsTaskCancelled(taskId, userId) {
  const task = tasks.get(taskId, userId);
  return task?.phase === 'cancelled' || (task?.status === 'error' && task?.error === 'Cancelled');
}

router.post('/hls-convert/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.has_hls) {
      const state = hlsConvert.analyzeHlsSegmentState(fileId, file.size);
      if (state.recoverable) return res.json({ success: true, message: 'Already has HLS' });
    }
    if (!file.mime_type?.startsWith('video/') && !file.name?.endsWith('.mp4')) {
      return res.status(400).json({ error: 'Only video files can be converted to HLS' });
    }

    const repos = hlsConvert.getHlsRepos(req.user.id);
    if (!repos.length) {
      return res.status(400).json({ error: 'No storage repositories with free space for HLS' });
    }
    const capacity = require('../services/capacity');
    const hlsFit = capacity.checkHlsConversionFits(repos, file.size);
    if (!hlsFit.fits) {
      return res.status(400).json({ error: capacity.hlsFitsError(hlsFit) });
    }

    const existing = db.prepare(`
      SELECT id FROM tasks
      WHERE user_id = ? AND type = 'hls-convert' AND status IN ('processing', 'pending')
        AND payload LIKE ?
    `).get(req.user.id, `%"fileId":"${fileId}"%`);
    if (existing) {
      return res.json({ success: true, taskId: existing.id, alreadyRunning: true });
    }

    const taskId = require('uuid').v4();
    tasks.create(req.user.id, {
      id: taskId,
      type: 'hls-convert',
      title: `Converting ${file.name} to HLS...`,
      payload: { fileId, fileName: file.name, resumable: false },
    });

    hlsConvert.convertFile(req.user.id, fileId, (p) => {
      updateHlsTaskProgress(taskId, req.user.id, p);
    }, taskId).then((result) => {
      if (!taskId || isHlsTaskCancelled(taskId, req.user.id)) return;
      tasks.update(taskId, req.user.id, {
        status: 'done', percent: 100, phase: 'done', file: result,
      });
    }).catch((err) => {
      if (!taskId || isHlsTaskCancelled(taskId, req.user.id)) return;
      if (err.message === 'Cancelled') return;
      tasks.appendLog(taskId, req.user.id, `HLS conversion failed: ${err.message}`);
      tasks.update(taskId, req.user.id, { status: 'error', error: err.message, resumable: false });
    });

    res.json({ success: true, taskId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function isVerifyHlsEligible(file) {
  if (!file || file.is_folder) return false;
  if (file.has_hls) return true;
  const count = hlsConvert.getHlsSegmentCount(file.id);
  return count > 0;
}

async function runVerifyHlsTask(userId, taskId, fileIds) {
  const results = [];
  for (let i = 0; i < fileIds.length; i++) {
    const fileId = fileIds[i];
    const file = db.prepare('SELECT id, name FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
    const name = file?.name || 'file';
    tasks.update(taskId, userId, {
      status: 'processing',
      phase: 'verify',
      percent: Math.round((i / fileIds.length) * 100),
      title: fileIds.length === 1
        ? `Verifying HLS: ${name}`
        : `Verifying HLS: ${name} (${i + 1}/${fileIds.length})`,
      done: i,
      total: fileIds.length,
      currentName: name,
      fileId,
      error: null,
    });

    const result = await hlsConvert.verifyHlsOnGitHub(userId, fileId, (p) => {
      const base = Math.round((i / fileIds.length) * 100);
      const slice = fileIds.length === 1 ? 100 : Math.round(100 / fileIds.length);
      tasks.update(taskId, userId, {
        status: 'processing',
        phase: p.phase === 'playlist' ? 'playlist' : 'verify',
        percent: Math.min(99, base + Math.round((p.percent / 100) * slice)),
        segmentsDone: p.checked,
        segmentsTotal: p.total,
        lastLog: p.phase === 'playlist'
          ? 'Checking m3u8 playlist on GitHub'
          : `Checking HLS segments on GitHub (${p.checked}/${p.total})`,
      });
    });

    results.push(result);
    const logLine = result.valid
      ? `${name}: all ${result.totalSegments} segment(s) verified`
      : `${name}: ${result.issues.join('; ')}`;
    tasks.appendLog(taskId, userId, logLine);
  }

  const failed = results.filter((r) => !r.valid);
  const last = results[results.length - 1];
  tasks.update(taskId, userId, {
    status: failed.length ? 'error' : 'done',
    phase: failed.length ? 'verify' : 'done',
    percent: 100,
    done: fileIds.length,
    total: fileIds.length,
    valid: failed.length === 0,
    issues: failed.flatMap((r) => r.issues.map((issue) => `${r.fileName}: ${issue}`)),
    missing: failed.flatMap((r) => r.missing),
    segmentsDone: last?.verified ?? 0,
    segmentsTotal: last?.totalSegments ?? 0,
    error: failed.length
      ? (fileIds.length === 1
        ? failed[0].issues[0] || 'HLS verification failed'
        : `${failed.length} of ${fileIds.length} file(s) have HLS issues`)
      : null,
    lastLog: failed.length
      ? failed.map((r) => `${r.fileName}: ${r.issues[0]}`).join('; ')
      : `All ${fileIds.length} file(s) verified — HLS segments complete`,
    resumable: false,
  });
  return results;
}

router.post('/verify-hls-batch', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.filter(Boolean))] : [];
    if (!ids.length) return res.status(400).json({ error: 'No files selected' });

    const eligible = [];
    const skipped = [];
    for (const id of ids) {
      const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(id, req.user.id);
      if (!file) continue;
      if (isVerifyHlsEligible(file)) eligible.push(id);
      else skipped.push(file.name);
    }
    if (!eligible.length) {
      return res.status(400).json({
        error: skipped.length
          ? 'Selected files have no HLS data to verify'
          : 'No valid files selected',
      });
    }

    const taskId = uuidv4();
    const title = eligible.length === 1
      ? `Verifying HLS: ${db.prepare('SELECT name FROM files WHERE id = ?').get(eligible[0])?.name || 'file'}`
      : `Verifying HLS (${eligible.length} files)`;

    tasks.create(req.user.id, {
      id: taskId,
      type: 'verify-hls',
      title,
      payload: { fileIds: eligible, skipped, done: 0, total: eligible.length },
    });

    (async () => {
      try {
        await runVerifyHlsTask(req.user.id, taskId, eligible);
      } catch (err) {
        tasks.appendLog(taskId, req.user.id, `HLS verification failed: ${err.message}`);
        tasks.update(taskId, req.user.id, { status: 'error', error: err.message, resumable: false });
      }
    })();

    res.json({ taskId, count: eligible.length, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/verify-hls', async (req, res) => {
  try {
    const fileId = req.params.id;
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!isVerifyHlsEligible(file)) {
      return res.status(400).json({ error: 'File has no HLS data to verify' });
    }

    const existing = db.prepare(`
      SELECT id FROM tasks
      WHERE user_id = ? AND type = 'verify-hls' AND status IN ('processing', 'pending')
        AND payload LIKE ?
    `).get(req.user.id, `%"${fileId}"%`);
    if (existing) {
      return res.json({ success: true, taskId: existing.id, alreadyRunning: true });
    }

    const taskId = uuidv4();
    tasks.create(req.user.id, {
      id: taskId,
      type: 'verify-hls',
      title: `Verifying HLS: ${file.name}`,
      payload: { fileId, fileIds: [fileId], fileName: file.name },
    });

    (async () => {
      try {
        await runVerifyHlsTask(req.user.id, taskId, [fileId]);
      } catch (err) {
        tasks.appendLog(taskId, req.user.id, `HLS verification failed: ${err.message}`);
        tasks.update(taskId, req.user.id, { status: 'error', error: err.message, resumable: false });
      }
    })();

    res.json({ success: true, taskId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/refresh-thumbnail/:id', async (req, res) => {
  try {
    const result = await storage.refreshThumbnail(req.user.id, req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/thumbnail/:id/upload', thumbUpload.single('thumbnail'), async (req, res) => {
  const fileId = req.params.id;
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    const buffer = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);
    const result = await storage.setCustomThumbnail(req.user.id, fileId, buffer);
    res.json({ success: true, ...result });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: err.message });
  }
});

router.post('/thumbnail-batch/upload', thumbUpload.array('thumbnails', 50), async (req, res) => {
  try {
    let fileIds = [];
    try {
      fileIds = JSON.parse(req.body.fileIds || '[]');
    } catch {
      return res.status(400).json({ error: 'Invalid fileIds payload' });
    }
    if (!Array.isArray(fileIds) || !fileIds.length) {
      return res.status(400).json({ error: 'No files selected' });
    }
    const uploads = req.files || [];
    if (!uploads.length) return res.status(400).json({ error: 'No images provided' });
    if (fileIds.length !== uploads.length) {
      return res.status(400).json({
        error: `Expected ${fileIds.length} image(s), received ${uploads.length}`,
      });
    }

    const names = db.prepare(`
      SELECT id, name FROM files
      WHERE user_id = ? AND is_folder = 0 AND id IN (${fileIds.map(() => '?').join(',')})
    `).all(req.user.id, ...fileIds);
    const nameById = new Map(names.map((row) => [row.id, row.name]));

    const taskId = uuidv4();
    const title = fileIds.length === 1
      ? `Setting thumbnail for ${nameById.get(fileIds[0]) || 'file'}`
      : `Setting thumbnails (${fileIds.length} files)`;

    tasks.create(req.user.id, {
      id: taskId,
      type: 'thumbnail-upload',
      title,
      payload: { fileIds, done: 0, total: fileIds.length },
    });

    (async () => {
      const errors = [];
      try {
        for (let i = 0; i < fileIds.length; i++) {
          const id = fileIds[i];
          const label = nameById.get(id) || 'file';
          tasks.update(taskId, req.user.id, {
            status: 'processing',
            phase: 'upload',
            percent: Math.round((i / fileIds.length) * 100),
            title: fileIds.length === 1
              ? `Setting thumbnail for ${label}`
              : `Setting thumbnail for ${label} (${i + 1}/${fileIds.length})`,
            done: i,
            total: fileIds.length,
            currentName: label,
            error: null,
          });
          const buffer = fs.readFileSync(uploads[i].path);
          try {
            await storage.setCustomThumbnail(req.user.id, id, buffer);
            tasks.appendLog(taskId, req.user.id, `Updated thumbnail for ${label}`);
          } catch (err) {
            errors.push(`${label}: ${err.message}`);
            tasks.appendLog(taskId, req.user.id, `Failed ${label}: ${err.message}`);
          } finally {
            try { fs.unlinkSync(uploads[i].path); } catch {}
          }
        }
        if (errors.length) {
          tasks.update(taskId, req.user.id, {
            status: 'error',
            phase: 'upload',
            percent: 100,
            done: fileIds.length,
            total: fileIds.length,
            error: errors.length === fileIds.length
              ? errors[0]
              : `${errors.length} of ${fileIds.length} thumbnail(s) failed`,
            lastLog: errors.join('; '),
            resumable: false,
          });
        } else {
          tasks.update(taskId, req.user.id, {
            status: 'done',
            phase: 'done',
            percent: 100,
            done: fileIds.length,
            total: fileIds.length,
            error: null,
            lastLog: `Updated ${fileIds.length} thumbnail(s)`,
            resumable: false,
          });
        }
      } catch (err) {
        for (const upload of uploads) {
          try { if (upload?.path && fs.existsSync(upload.path)) fs.unlinkSync(upload.path); } catch {}
        }
        tasks.update(taskId, req.user.id, {
          status: 'error',
          error: err.message,
          resumable: false,
        });
      }
    })();

    res.json({ taskId, count: fileIds.length });
  } catch (err) {
    for (const upload of req.files || []) {
      try { if (upload?.path && fs.existsSync(upload.path)) fs.unlinkSync(upload.path); } catch {}
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/verify-repair/init', async (req, res) => {
  try {
    const fileId = req.params.id;
    const { size, fileName } = req.body;
    const file = db.prepare(`
      SELECT * FROM files
      WHERE id = ? AND user_id = ? AND is_folder = 0
        AND (upload_status IS NULL OR upload_status = 'ready')
    `).get(fileId, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!size) return res.status(400).json({ error: 'Local file size required' });
    if (parseInt(size, 10) !== file.size) {
      return res.status(400).json({
        error: `Local file size (${size}) does not match vault file (${file.size})`,
      });
    }

    const existing = db.prepare(`
      SELECT id FROM tasks
      WHERE user_id = ? AND type = 'verify-repair' AND status IN ('processing', 'pending')
        AND payload LIKE ?
    `).get(req.user.id, `%"fileId":"${fileId}"%`);
    if (existing) {
      return res.json({ success: true, taskId: existing.id, alreadyRunning: true });
    }

    const taskId = uuidv4();
    tasks.create(req.user.id, {
      id: taskId,
      type: 'verify-repair',
      title: `Verifying ${file.name}`,
      payload: { fileId, fileName: file.name, localFileName: fileName || null },
    });
    tasks.update(taskId, req.user.id, { status: 'processing', phase: 'verify', percent: 0 });

    const verify = await storage.verifyFileChunksOnGitHub(req.user.id, fileId, (p) => {
      tasks.update(taskId, req.user.id, {
        status: 'processing',
        phase: 'verify',
        percent: p.percent,
        chunksDone: p.verified,
        chunksTotal: p.total,
        lastLog: `Checked ${p.checked}/${p.total} chunks on GitHub`,
      });
    });

    const chunkSize = storage.getChunkSizeForFile(fileId, file);
    const phase = verify.valid ? 'done' : 'repair';
    tasks.update(taskId, req.user.id, {
      status: verify.valid ? 'done' : 'processing',
      phase,
      percent: verify.valid ? 100 : 50,
      chunksDone: verify.verified,
      chunksTotal: verify.totalChunks,
      missingChunks: verify.missing,
      lastLog: verify.valid
        ? `All ${verify.totalChunks} chunks verified on GitHub`
        : `${verify.missing.length} chunk(s) missing — repair from local file`,
      resumable: false,
    });

    res.json({
      success: true,
      taskId,
      valid: verify.valid,
      missing: verify.missing,
      verified: verify.verified,
      totalChunks: verify.totalChunks,
      chunkSize,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/verify-repair/chunk', chunkUpload.single('chunk'), async (req, res) => {
  const fileId = req.params.id;
  const taskId = req.body.taskId;
  const chunkIndex = parseInt(req.body.chunkIndex, 10);
  try {
    if (!req.file) return res.status(400).json({ error: 'No chunk provided' });
    const buffer = fs.readFileSync(req.file.path);
    fs.unlinkSync(req.file.path);

    if (taskId) {
      tasks.update(taskId, req.user.id, {
        status: 'processing',
        phase: 'repair',
        lastLog: `Uploading missing chunk ${chunkIndex}...`,
      });
    }

    const result = await storage.repairFileChunk(
      req.user.id,
      fileId,
      chunkIndex,
      buffer,
      taskId ? { taskId, userId: req.user.id } : null
    );

    if (taskId) {
      tasks.update(taskId, req.user.id, {
        status: 'processing',
        phase: 'repair',
        chunksDone: result.chunksDone,
        chunksTotal: result.totalChunks,
        percent: Math.max(50, result.percent || 0),
        currentRepo: result.currentRepo || null,
        lastLog: result.skipped
          ? `Chunk ${chunkIndex} already on GitHub`
          : `Repaired chunk ${chunkIndex} on ${result.currentRepo || 'storage'}`,
      });
    }

    res.json(result);
  } catch (err) {
    if (taskId) {
      tasks.update(taskId, req.user.id, { status: 'error', error: err.message, phase: 'repair' });
      tasks.appendLog(taskId, req.user.id, `Chunk ${chunkIndex} repair failed: ${err.message}`);
    }
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/verify-repair/complete', async (req, res) => {
  const { taskId } = req.body;
  try {
    const result = await storage.finalizeFileRepair(req.user.id, req.params.id);
    if (taskId) {
      tasks.update(taskId, req.user.id, {
        status: 'done',
        phase: 'done',
        percent: 100,
        lastLog: 'File verification and repair complete',
      });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    if (taskId) {
      tasks.update(taskId, req.user.id, { status: 'error', error: err.message, phase: 'repair' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/thumbnail/:id/refresh', async (req, res) => {
  try {
    const result = await storage.refreshThumbnail(req.user.id, req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});



function startDownloadJob(userId, fileId, sessionId, view) {
  const db = require('../db/database');
  const meta = db.prepare(
    'SELECT name, chunk_count FROM files WHERE id = ? AND user_id = ? AND is_folder = 0'
  ).get(fileId, userId);
  if (!meta) {
    downloadSession.fail(sessionId, 'File not found');
    return;
  }

  const chunks = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE file_id = ?').get(fileId);
  const total = meta.chunk_count || chunks?.n || 1;
  downloadSession.update(sessionId, { total });

  storage.downloadFileWithProgress(
    userId,
    fileId,
    (fetched, chunkTotal, stage) => {
      downloadSession.update(sessionId, {
        fetched,
        total: chunkTotal || total,
        stage: stage || 'fetching',
      });
    },
    view
  ).then(({ buffer, file }) => {
    downloadSession.complete(sessionId, buffer, file);
  }).catch((err) => {
    downloadSession.fail(sessionId, err.message);
  });
}

router.post('/download/:id/prepare', (req, res) => {
  try {
    const view = viewMode.parseViewParam(req.query.view);
    const fileId = req.params.id;
    const db = require('../db/database');
    const file = db.prepare(
      'SELECT name, chunk_count FROM files WHERE id = ? AND user_id = ? AND is_folder = 0'
    ).get(fileId, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const sessionId = downloadSession.create({
      userId: req.user.id,
      fileId,
      view,
    });
    const session = downloadSession.get(sessionId);
    startDownloadJob(req.user.id, fileId, sessionId, view);

    res.json({
      sessionId,
      authToken: session.authToken,
      expiresAt: session.createdAt + downloadSession.TTL_MS,
      total: file.chunk_count || 1,
      fileName: file.name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/download/status/:sessionId', (req, res) => {
  const session = downloadSession.get(req.params.sessionId);
  if (!session || session.userId !== req.user.id) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(downloadSession.toStatus(session));
});

router.delete('/:id', async (req, res) => {
  try {
    const db = require('../db/database');
    const file = db.prepare('SELECT name FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const taskId = require('uuid').v4();
    tasks.create(req.user.id, {
      id: taskId,
      type: 'delete',
      title: `Deleting ${file.name}`,
      payload: { ids: [req.params.id], names: [file.name], done: 0, total: 1 },
    });

    const deleteTimeout = setTimeout(() => {
      tasks.update(taskId, req.user.id, {
        status: 'done', phase: 'done', percent: 100, done: 1, total: 1,
        error: null, resumable: false,
      });
      logger.warn('delete_file_timed_out', { userId: req.user.id, fileId: req.params.id });
    }, 60000);

    storage.deleteFile(req.user.id, req.params.id)
      .then(() => {
        clearTimeout(deleteTimeout);
        tasks.update(taskId, req.user.id, {
          status: 'done', phase: 'done', percent: 100, done: 1, total: 1,
        });
      })
      .catch((err) => {
        clearTimeout(deleteTimeout);
        tasks.update(taskId, req.user.id, { status: 'error', error: err.message });
      });

    res.json({ success: true, taskId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/folder', async (req, res) => {
  try {
    const { name, path: parentPath } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name required' });
    const folder = await storage.createFolder(req.user.id, name, parentPath || '/');
    res.json({ success: true, folder });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/move', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    const destination = req.body.destination ?? req.body.path ?? '/';
    if (!ids.length) return res.status(400).json({ error: 'No items selected' });
    const result = await storage.moveItems(req.user.id, ids, destination);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    res.json(await storage.getStorageStats(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Audit & Integrity -------------------------------------------------

router.get('/integrity/:id', (req, res) => {
  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ? AND is_folder = 0').get(req.params.id, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const result = contentHash.verifyChunks(req.params.id);
    res.json({ fileId: req.params.id, name: file.name, content_hash: file.content_hash, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/audit', (req, res) => {
  try {
    const opts = {
      action: req.query.action || null,
      limit: Math.min(parseInt(req.query.limit, 10) || 100, 500),
      offset: parseInt(req.query.offset, 10) || 0,
    };
    res.json({ entries: audit.query(req.user.id, opts) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/complete-audit', (req, res) => {
  try {
    const opts = {
      action: req.query.action || null,
      limit: Math.min(parseInt(req.query.limit, 10) || 100, 500),
      offset: parseInt(req.query.offset, 10) || 0,
    };
    res.json({ entries: audit.query(null, opts) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Recent files, Favorites, Trash ---

router.get('/recent', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const rows = db.prepare(`
      SELECT id, name, path, size, mime_type, is_folder, parent_path, chunk_count, has_thumbnail, created_at, last_accessed
      FROM files
      WHERE user_id = ? AND (upload_status IS NULL OR upload_status = 'ready') AND is_deleted = 0 AND is_folder = 0
        AND last_accessed IS NOT NULL
      ORDER BY last_accessed DESC LIMIT ?
    `).all(req.user.id, limit);
    res.json({ files: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/accessed', (req, res) => {
  try {
    db.prepare("UPDATE files SET last_accessed = datetime('now') WHERE id = ? AND user_id = ?")
      .run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/favorite', (req, res) => {
  try {
    const file = db.prepare('SELECT is_favorite FROM files WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const next = file.is_favorite ? 0 : 1;
    db.prepare('UPDATE files SET is_favorite = ? WHERE id = ? AND user_id = ?').run(next, req.params.id, req.user.id);
    res.json({ success: true, is_favorite: !!next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/favorites', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, name, path, size, mime_type, is_folder, parent_path, chunk_count, has_thumbnail, has_hls, created_at, is_favorite,
        (SELECT COUNT(*) FROM hls_segments WHERE file_id = files.id) AS hls_segment_count,
        (SELECT COALESCE(SUM(duration), 0) FROM hls_segments WHERE file_id = files.id) AS hls_duration_sec
      FROM files
      WHERE user_id = ? AND (upload_status IS NULL OR upload_status = 'ready') AND is_deleted = 0 AND is_favorite = 1
      ORDER BY name ASC
    `).all(req.user.id);
    res.json({ files: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/trash', (req, res) => {
  try {
    db.prepare("UPDATE files SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ? AND user_id = ? AND is_folder = 0")
      .run(req.params.id, req.user.id);
    audit.log(req.user.id, 'trash', { targetType: 'file', targetId: req.params.id, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/trash', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, name, path, size, mime_type, is_folder, parent_path, chunk_count, has_thumbnail, created_at, deleted_at
      FROM files
      WHERE user_id = ? AND is_deleted = 1
      ORDER BY is_folder DESC, COALESCE(deleted_at, created_at) DESC LIMIT 200
    `).all(req.user.id);
    res.json({ files: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/restore', (req, res) => {
  try {
    db.prepare('UPDATE files SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND user_id = ?')
      .run(req.params.id, req.user.id);
    audit.log(req.user.id, 'restore', { targetType: 'file', targetId: req.params.id, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/permanent', async (req, res) => {
  try {
    const file = db.prepare('SELECT name FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    await storage.deleteFile(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/search', (req, res) => {
  try {
    const q = req.query.q || '';
    const opts = {
      limit: req.query.limit || 100,
      sort: req.query.sort || 'name',
      order: req.query.order === 'desc' ? 'DESC' : 'ASC',
    };
    const result = storage.searchFilesGlobal(req.user.id, q, opts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/trash-batch', (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'No items specified' });
    const moved = storage.softTrashItems(req.user.id, ids);
    res.json({ success: true, moved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/restore-batch', (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'No items specified' });
    const restored = storage.restoreItems(req.user.id, ids);
    res.json({ success: true, restored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/storage-health', (req, res) => {
  try {
    const storageHealth = require('../services/storage-health');
    const linkedAccountId = req.query.account_id ? parseInt(req.query.account_id, 10) : null;
    const report = storageHealth.listOrphanChunks(req.user.id, {
      limit: parseInt(req.query.limit, 10) || 100,
      linkedAccountId: Number.isFinite(linkedAccountId) ? linkedAccountId : null,
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/storage-health/clear-backoff', (req, res) => {
  try {
    const storageHealth = require('../services/storage-health');
    const accountId = parseInt(req.body.account_id, 10);
    if (!Number.isFinite(accountId)) return res.status(400).json({ error: 'account_id required' });
    const cleared = storageHealth.clearBackoffForAccount(req.user.id, accountId);
    res.json({ success: true, cleared });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/storage-health/failure/:chunkId/:accountId', (req, res) => {
  try {
    const storageHealth = require('../services/storage-health');
    const ok = storageHealth.cleanupOrphanFailure(
      req.user.id,
      parseInt(req.params.chunkId, 10),
      parseInt(req.params.accountId, 10)
    );
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/shared', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, name, path, size, mime_type, is_folder, parent_path, chunk_count, has_thumbnail, created_at, share_token
      FROM files
      WHERE user_id = ? AND share_token IS NOT NULL AND is_deleted = 0
        AND (upload_status IS NULL OR upload_status = 'ready')
      ORDER BY name ASC
    `).all(req.user.id);
    res.json({ files: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
