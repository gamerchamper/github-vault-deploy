const ChunkBlocks = {
  MAX_DISPLAY: 120,

  computeLayout(totalChunks) {
    const total = Math.max(1, totalChunks || 1);
    const displayCount = Math.min(total, this.MAX_DISPLAY);
    const ratio = total / displayCount;
    return { total, displayCount, ratio };
  },

  chunkToDisplayIndex(chunkIndex, ratio, displayCount) {
    return Math.min(displayCount - 1, Math.floor(chunkIndex / ratio));
  },

  blockClass(i, displayDone, displayActive, isDecrypt) {
    if (i < displayDone) {
      return isDecrypt
        ? 'chunk-block chunk-block--decrypt'
        : 'chunk-block chunk-block--done';
    }
    if (i === displayActive && !isDecrypt) return 'chunk-block chunk-block--active';
    return 'chunk-block chunk-block--pending';
  },

  mount(container, options = {}) {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) return null;

    const { total = 1, label = 'Blocks' } = options;
    const layout = this.computeLayout(total);

    el.innerHTML = `
      <div class="chunk-blocks-header">
        <span class="chunk-blocks-label">${label}</span>
        <span class="chunk-blocks-meta"></span>
      </div>
      <div class="chunk-blocks-grid vault-scroll" role="img" aria-label="Chunk progress"></div>
    `;

    const grid = el.querySelector('.chunk-blocks-grid');
    const fragment = document.createDocumentFragment();
    const blocks = [];

    for (let i = 0; i < layout.displayCount; i += 1) {
      const block = document.createElement('div');
      block.className = 'chunk-block chunk-block--pending';
      block.dataset.index = String(i);
      fragment.appendChild(block);
      blocks.push(block);
    }
    grid.appendChild(fragment);

    const instance = {
      el,
      grid,
      metaEl: el.querySelector('.chunk-blocks-meta'),
      blocks,
      layout,
      lastDone: -1,
      lastActive: -1,
      allDone: false,
      lastMeta: '',
      raf: null,
      pendingState: null,
    };

    this.updateInstance(instance, { completed: 0, total, stage: 'starting' });
    return instance;
  },

  stageLabel(stage) {
    const labels = {
      starting: 'Starting',
      cached: 'Cached',
      fetching: 'Fetching',
      decrypting: 'Decrypting',
      streaming: 'Buffering',
      caching: 'Caching',
      ready: 'Ready',
      done: 'Complete',
      hls: 'Segments',
      error: 'Error',
    };
    return labels[stage] || stage || 'Loading';
  },

  applyBlockRange(instance, from, to, displayDone, displayActive, isDecrypt) {
    const start = Math.max(0, from);
    const end = Math.min(instance.blocks.length - 1, to);
    for (let i = start; i <= end; i += 1) {
      const next = this.blockClass(i, displayDone, displayActive, isDecrypt);
      if (instance.blocks[i].className !== next) {
        instance.blocks[i].className = next;
      }
    }
  },

  updateInstance(instance, { completed = 0, total, stage = 'fetching', activeIndex = null }) {
    if (!instance) return;

    if (total && total !== instance.layout.total) {
      return this.mount(instance.el, {
        total,
        label: instance.el.querySelector('.chunk-blocks-label')?.textContent || 'Blocks',
      });
    }

    const chunkTotal = instance.layout.total;
    const chunkDone = Math.min(chunkTotal, Math.max(0, completed));
    const { ratio, displayCount } = instance.layout;

    let displayDone = displayCount;
    if (chunkDone < chunkTotal) {
      displayDone = this.chunkToDisplayIndex(chunkDone, ratio, displayCount);
    }

    let displayActive = displayDone;
    if (activeIndex != null) {
      displayActive = this.chunkToDisplayIndex(activeIndex, ratio, displayCount);
    } else if (chunkDone < chunkTotal && stage !== 'decrypting' && stage !== 'done' && stage !== 'cached') {
      displayActive = Math.min(displayCount - 1, displayDone);
    }

    const isDecrypt = stage === 'decrypting';
    const isComplete = stage === 'done' || stage === 'ready' || stage === 'cached' || chunkDone >= chunkTotal;

    const pct = chunkTotal > 0 ? Math.round((chunkDone / chunkTotal) * 100) : 0;
    const meta = `${chunkDone} / ${chunkTotal} · ${this.stageLabel(stage)} · ${pct}%`;

    if (isComplete) {
      if (!instance.allDone) {
        for (const block of instance.blocks) {
          if (!block.classList.contains('chunk-block--done')) {
            block.className = 'chunk-block chunk-block--done';
          }
        }
        instance.allDone = true;
      }
    } else {
      instance.allDone = false;
      const prevDone = instance.lastDone;
      const prevActive = instance.lastActive;

      if (prevDone < 0) {
        this.applyBlockRange(instance, 0, displayCount - 1, displayDone, displayActive, isDecrypt);
      } else if (displayDone > prevDone || displayActive !== prevActive || isDecrypt) {
        const from = Math.min(prevDone, displayDone, prevActive, displayActive);
        const to = Math.max(displayDone, displayActive, prevDone, prevActive);
        this.applyBlockRange(instance, from, to, displayDone, displayActive, isDecrypt);
      }
    }

    if (instance.metaEl && instance.lastMeta !== meta) {
      instance.metaEl.textContent = meta;
      instance.lastMeta = meta;
    }

    instance.lastDone = displayDone;
    instance.lastActive = displayActive;
  },

  update(instance, state) {
    if (!instance) return;
    instance.pendingState = state;
    if (instance.raf) return;
    instance.raf = requestAnimationFrame(() => {
      instance.raf = null;
      if (instance.pendingState) {
        this.updateInstance(instance, instance.pendingState);
        instance.pendingState = null;
      }
    });
  },

  destroy(instance) {
    if (!instance) return;
    if (instance.raf) {
      cancelAnimationFrame(instance.raf);
      instance.raf = null;
    }
    if (instance.el) instance.el.innerHTML = '';
  },

  fromStreamStatus(status, file) {
    const total = status?.total_segments || file?.chunk_count || 0;
    const completed = status?.segments || 0;
    const stage = status?.stage || status?.mode || 'streaming';
    return { completed, total, stage };
  },

  stateKey(state) {
    return `${state.completed}:${state.total}:${state.stage}`;
  },

  fromDownloadStatus(status) {
    return {
      completed: status?.fetched || 0,
      total: status?.total || 0,
      stage: status?.stage || 'fetching',
    };
  },
};
