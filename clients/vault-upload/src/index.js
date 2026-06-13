#!/usr/bin/env node

const { program } = require('commander');
const { VaultApi } = require('./api');
const { UploadEngine, DEFAULT_CONCURRENCY } = require('./upload-engine');
const { SessionStore } = require('./session-store');
const { load, save, addToServerHistory } = require('./config');
const { renderProgressLine, renderFinalLine, renderTable } = require('./progress');
const path = require('path');
const fs = require('fs');
const { startUiServer } = require('./ui-server');
const { startDesktopProcess } = require('./desktop');

const fetch = require('node-fetch');

const pkg = require('../package.json');

async function tryAutoConnect(config) {
  const defaults = ['http://localhost:3000', 'http://127.0.0.1:3000'];
  for (const url of defaults) {
    try {
      const healthRes = await fetch(`${url}/health`, { timeout: 3000 });
      if (!healthRes.ok) continue;
      const provisionRes = await fetch(`${url}/auth/local-provision`, {
        method: 'POST',
        headers: { 'X-Vault-Local': '1' },
        timeout: 4000,
      });
      if (!provisionRes.ok) continue;
      const data = await provisionRes.json();
      config.serverUrl = data.serverUrl || url;
      config.apiKey = data.key;
      save(config);
      console.log(`Auto-connected to ${config.serverUrl}`);
      return true;
    } catch {}
  }
  return false;
}

async function ensureAuth(config) {
  if (config.serverUrl && (config.apiKey || config.cookie)) return true;
  console.log('No credentials configured. Trying auto-connect...');
  const ok = await tryAutoConnect(config);
  if (!ok) {
    console.error('Could not auto-connect to a local Vault server.');
    console.error('Run: vault-upload auth --url <server-url> --api-key <key>');
    process.exit(1);
  }
  return true;
}

program
  .name('vault-upload')
  .description('Resilient CLI upload client for GitHub Vault')
  .version(pkg.version);

program
  .command('desktop')
  .description('Launch the native desktop interface')
  .option('--host <host>', 'Host to bind the local UI server', '127.0.0.1')
  .option('--port <port>', 'Port to bind the local UI server, 0 for auto', parseInt, 0)
  .action((opts) => {
    try {
      const child = startDesktopProcess({ host: opts.host, port: opts.port });
      child.on('exit', (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        process.exit(code || 0);
      });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

program
  .command('ui')
  .description('Launch the local browser interface')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option('--port <port>', 'Port to bind', parseInt, 4173)
  .action((opts) => {
    startUiServer({ host: opts.host, port: opts.port });
  });

program
  .command('auth')
  .description('Set the server URL and session cookie or API key')
  .option('-u, --url <url>', 'Vault server URL (e.g. https://vault.example.com)')
  .option('-c, --cookie <cookie>', 'Session cookie value (vault.sid=...)')
  .option('-k, --api-key <key>', 'API key value (gv_...)')
  .action((opts) => {
    const config = load();
    if (opts.url) config.serverUrl = opts.url.replace(/\/+$/, '');
    if (opts.cookie) config.cookie = opts.cookie;
    if (opts.apiKey) config.apiKey = opts.apiKey;
    if (config.serverUrl && (config.apiKey || config.cookie)) {
      config.serverHistory = addToServerHistory(config);
    }
    save(config);

    if (config.serverUrl && (config.apiKey || config.cookie)) {
      const api = new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey });
      api.checkAuth().then(ok => {
        if (ok) {
          console.log('Authenticated successfully.');
        } else {
          console.log('Credentials saved but auth check failed — cookie/API key may be invalid.');
        }
      }).catch(() => {
        console.log('Could not reach server. Config saved.');
      });
    } else {
      console.log('Configuration saved. Use --url with --api-key or --cookie.');
    }
  });

program
  .command('create-api-key')
  .description('Create an API key using the configured session cookie')
  .option('-n, --name <name>', 'API key name', 'Vault Upload Client')
  .option('--save', 'Save the created API key to client config')
  .action(async (opts) => {
    const config = load();
    if (!config.serverUrl) return console.error('Server URL not set. Run vault-upload auth --url <url>');
    if (!config.cookie) return console.error('Session cookie required to create an API key. Run vault-upload auth --cookie <cookie> first.');
    const api = new VaultApi(config.serverUrl, { cookie: config.cookie });
    try {
      const result = await api.createApiKey(opts.name);
      console.log(`API key created: ${result.key.key}`);
      if (opts.save) {
        config.apiKey = result.key.key;
        save(config);
        console.log('API key saved to client config.');
      }
    } catch (err) {
      console.error('Create API key failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('plan')
  .description('Get upload plan (chunk count, repo distribution)')
  .requiredOption('-f, --file <path>', 'Path to the file')
  .option('--chunk-size <bytes>', 'Chunk size in bytes', parseInt)
  .action(async (opts) => {
    const config = load();
    if (!config.serverUrl && !config.apiKey && !config.cookie) await ensureAuth(config);
    if (!config.serverUrl) return console.error('Server URL not set. Run vault-upload auth --url <url>');
    const api = new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey });
    const stat = fs.statSync(opts.file);
    try {
      const plan = await api.plan(stat.size, opts.chunkSize);
      console.log(JSON.stringify(plan, null, 2));
    } catch (err) {
      console.error('Plan failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('upload')
  .description('Upload a file with automatic resume on failure')
  .requiredOption('-f, --file <path>', 'Path to the file')
  .option('-p, --parent-path <dir>', 'Parent directory in vault', '/')
  .option('--chunk-size <bytes>', 'Chunk size in bytes', parseInt)
  .option('--concurrency <n>', 'Upload concurrency', parseInt, DEFAULT_CONCURRENCY)
  .option('--mode <mode>', 'Upload mode: api or git', 'api')
  .option('--convert-hls', 'Convert video to HLS after upload')
  .option('--resume <taskId>', 'Resume a previous upload task')
  .action(async (opts) => {
    const config = load();
    if (!config.serverUrl && !config.apiKey && !config.cookie) await ensureAuth(config);
    if (!config.serverUrl) return console.error('Server URL not set. Run vault-upload auth --url <url>');
    if (!config.cookie && !config.apiKey) return console.error('Credentials not set. Run vault-upload auth --api-key <key> or --cookie <cookie>');

    const filePath = path.resolve(opts.file);
    if (!fs.existsSync(filePath)) return console.error(`File not found: ${filePath}`);

    const api = new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey });

    const engine = new UploadEngine(api, {
      concurrency: opts.concurrency,
      chunkSize: opts.chunkSize,
      uploadMode: opts.mode,
      convertHls: opts.convertHls,
      onProgress: (p) => {
        process.stdout.write(renderProgressLine(p));
      },
      onLog: (msg) => {
        process.stdout.write(`\n  [${new Date().toLocaleTimeString()}] ${msg}`);
      },
    });

    let abortHandler = () => {
      console.log('\nAborting...');
      engine.abort();
    };
    process.on('SIGINT', abortHandler);
    process.on('SIGTERM', abortHandler);

    try {
      let init;

      if (opts.resume) {
        console.log(`Resuming upload ${opts.resume}...`);
        init = await engine.resumeSession(opts.resume);
      } else {
        const taskId = SessionStore.generateTaskId();
        console.log(`Uploading ${path.basename(filePath)} (${engine._computeChunkSize(fs.statSync(filePath).size)}B chunks)...`);
        init = await engine.initSession(filePath, opts.parentPath, null, taskId);
      }

      console.log(`  File ID: ${init.fileId}`);
      console.log(`  Chunks: ${init.chunksDone}/${init.totalChunks} done, next: ${init.nextChunk}`);

      if (init.nextChunk >= init.totalChunks) {
        console.log('All chunks already uploaded, completing...');
      }

      const result = await engine.uploadAll();
      console.log(renderFinalLine(result));
    } catch (err) {
      console.error(`\nUpload failed: ${err.message}`);
      process.exit(1);
    } finally {
      process.removeListener('SIGINT', abortHandler);
      process.removeListener('SIGTERM', abortHandler);
    }
  });

program
  .command('status')
  .description('Check upload status')
  .argument('<taskId>', 'Task ID to check')
  .action(async (taskId) => {
    const config = load();
    if (!config.serverUrl) return console.error('Server URL not set');
    const api = new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey });
    const engine = new UploadEngine(api);
    try {
      const { session, remote } = await engine.status(taskId);
      if (session) {
        console.log('Local session:');
        console.log(`  File:      ${session.fileName}`);
        console.log(`  Status:    ${session.status}`);
        console.log(`  Chunks:    ${session.chunksDone}/${session.totalChunks}`);
        console.log(`  File ID:   ${session.fileId}`);
        if (session.error) console.log(`  Error:     ${session.error}`);
      }
      if (remote) {
        console.log('Remote task:');
        console.log(`  Status:    ${remote.status}`);
        console.log(`  Phase:     ${remote.phase}`);
        console.log(`  Percent:   ${remote.percent}%`);
        console.log(`  Chunks:    ${remote.chunksDone || 0}/${remote.chunksTotal || 0}`);
        console.log(`  Error:     ${remote.error || 'none'}`);
        console.log(`  Resumable: ${remote.resumable !== false}`);
      }
      if (!session && !remote) {
        console.log('No session or task found.');
      }
    } catch (err) {
      console.error('Status check failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('cancel')
  .description('Cancel an upload')
  .argument('<taskId>', 'Task ID to cancel')
  .action(async (taskId) => {
    const config = load();
    if (!config.serverUrl) return console.error('Server URL not set');
    const api = new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey });
    const session = SessionStore.get(taskId);
    try {
      await api.uploadCancel(session?.fileId || null, taskId);
      await api.cancelTask(taskId).catch(() => {});
      SessionStore.remove(taskId);
      console.log('Upload cancelled.');
    } catch (err) {
      console.error('Cancel failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List active upload sessions')
  .action(() => {
    const sessions = SessionStore.listInterrupted();
    console.log(renderTable(sessions));
  });

program
  .command('pause')
  .description('Pause an active upload')
  .argument('<taskId>', 'Task ID to pause')
  .option('-r, --reason <reason>', 'Pause reason', 'Paused by CLI client')
  .action(async (taskId, opts) => {
    const config = load();
    if (!config.serverUrl) return console.error('Server URL not set');
    const api = new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey });
    try {
      const result = await api.pauseTask(taskId, opts.reason);
      const session = SessionStore.get(taskId);
      if (session) {
        session.status = 'paused';
        SessionStore.save(session);
      }
      console.log(`Task ${taskId} paused.`);
    } catch (err) {
      console.error('Pause failed:', err.message);
      process.exit(1);
    }
  });

program
  .command('delete')
  .description('Delete a task from history (local session + remote)')
  .argument('<taskId>', 'Task ID to delete')
  .action(async (taskId) => {
    const config = load();
    if (!config.serverUrl) return console.error('Server URL not set');
    const api = new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey });
    try {
      await api.deleteTask(taskId);
    } catch {}
    SessionStore.remove(taskId);
    console.log(`Task ${taskId} deleted.`);
  });

program
  .command('list-remote')
  .description('List remote tasks')
  .option('-a, --active', 'Only active tasks', true)
  .option('-r, --resumable', 'Include resumable tasks', false)
  .action(async (opts) => {
    const config = load();
    if (!config.serverUrl) return console.error('Server URL not set');
    const api = new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey });
    try {
      const result = await api.listTasks(opts.active, opts.resumable);
      const tasks = result.tasks || [];
      if (tasks.length === 0) return console.log('No tasks found.');
      for (const t of tasks) {
        const pct = t.percent != null ? `${t.percent}%` : `${t.chunksDone || 0}/${t.chunksTotal || 0}`;
        console.log(`${t.id.padEnd(40)} ${(t.status || '').padEnd(12)} ${(t.phase || '').padEnd(14)} ${pct.padEnd(8)} ${t.title || ''}`);
      }
    } catch (err) {
      console.error('List failed:', err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.help();
}
