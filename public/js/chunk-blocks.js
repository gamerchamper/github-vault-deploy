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

  computeSquareGrid(count, width, height, gap = 2, padding = 4) {
    const availW = Math.max(0, width - padding * 2);
    const availH = Math.max(0, height - padding * 2);
    if (availW < 1 || availH < 1 || count < 1) {
      return { cols: 1, size: 4, rows: count };
    }

    let best = { cols: 1, size: 0, rows: count };
    for (let cols = 1; cols <= count; cols += 1) {
      const rows = Math.ceil(count / cols);
      const sizeW = (availW - gap * (cols - 1)) / cols;
      const sizeH = (availH - gap * (rows - 1)) / rows;
      const size = Math.min(sizeW, sizeH);
      if (size > best.size) best = { cols, size, rows };
    }

    best.size = Math.floor(best.size);
    while (best.size > 0) {
      const totalW = padding * 2 + best.cols * best.size + gap * (best.cols - 1);
      const totalH = padding * 2 + best.rows * best.size + gap * (best.rows - 1);
      if (totalW <= width + 0.5 && totalH <= height + 0.5) break;
      best.size -= 1;
    }
    return best;
  },

  measureFillArea(instance) {
    const wrap = instance.el;
    const grid = instance.grid;
    if (!wrap || !grid) return { width: 0, height: 0 };

    const width = wrap.clientWidth || grid.clientWidth;
    const header = wrap.querySelector('.chunk-blocks-header');
    const padding = instance.gridPadding ?? 4;
    const layout = wrap.closest('.share-cinema-layout, .share-app-frame, main');
    const viewportBottom = window.visualViewport
      ? window.visualViewport.offsetTop + window.visualViewport.height
      : window.innerHeight;
    const boundsBottom = layout?.getBoundingClientRect().bottom ?? viewportBottom;
    const maxBottom = Math.min(boundsBottom, viewportBottom);
    const top = header?.getBoundingClientRect().bottom ?? wrap.getBoundingClientRect().top;
    const height = Math.max(0, maxBottom - top - padding);

    return { width, height };
  },

  reflowGrid(instance) {
    if (!instance?.fill || !instance.grid) return;
    const { grid, blocks } = instance;
    const gap = instance.gridGap ?? 2;
    const padding = instance.gridPadding ?? 4;
    const { width, height } = this.measureFillArea(instance);
    if (width < 1 || height < 1) return;

    const { cols, size, rows } = this.computeSquareGrid(blocks.length, width, height, gap, padding);
    if (size < 1) return;

    const key = `${width}|${height}|${cols}|${size}`;
    if (instance._lastReflowKey === key) return;
    instance._lastReflowKey = key;

    const contentH = padding * 2 + rows * size + gap * (rows - 1);
    const gridH = Math.min(height, contentH);

    grid.style.flex = '1 1 0';
    grid.style.height = `${Math.floor(gridH)}px`;
    grid.style.maxHeight = `${Math.floor(height)}px`;
    grid.style.width = '100%';
    grid.style.boxSizing = 'border-box';
    grid.style.gridTemplateColumns = `repeat(${cols}, ${size}px)`;
    grid.style.gridAutoRows = `${size}px`;
    grid.style.justifyContent = 'center';
    grid.style.alignContent = 'center';
  },

  bindGridReflow(instance) {
    if (!instance.fill || !instance.grid) return;
    instance._reflow = () => this.reflowGrid(instance);
    instance._reflow();
    requestAnimationFrame(() => instance._reflow());
    if (typeof ResizeObserver !== 'undefined') {
      instance._ro = new ResizeObserver(() => {
        if (instance.rafReflow) cancelAnimationFrame(instance.rafReflow);
        instance.rafReflow = requestAnimationFrame(() => {
          instance.rafReflow = null;
          this.reflowGrid(instance);
        });
      });
      for (const node of [
        instance.el,
        instance.el?.closest('#share-stats, .viewer-stats'),
        instance.el?.closest('.share-dock-stats'),
        instance.el?.closest('.share-cinema-dock'),
        instance.el?.closest('.share-cinema-layout'),
      ]) {
        if (node) instance._ro.observe(node);
      }
    } else {
      window.addEventListener('resize', instance._reflow);
    }
  },

  unbindGridReflow(instance) {
    if (!instance) return;
    instance._ro?.disconnect();
    instance._ro = null;
    if (instance._reflow) {
      window.removeEventListener('resize', instance._reflow);
      instance._reflow = null;
    }
    if (instance.rafReflow) {
      cancelAnimationFrame(instance.rafReflow);
      instance.rafReflow = null;
    }
  },

  mount(container, options = {}) {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) return null;

    const { total = 1, label = 'Blocks' } = options;
    const layout = this.computeLayout(total);

    const fill = options.fill ?? !!el.closest('.share-dock-stats');
    const gridGap = options.gridGap ?? 2;
    const gridPadding = options.gridPadding ?? 4;

    el.innerHTML = `
      <div class="chunk-blocks-header">
        <span class="chunk-blocks-label">${label}</span>
        <span class="chunk-blocks-meta"></span>
      </div>
      <div class="chunk-blocks-grid vault-scroll" role="img" aria-label="Chunk progress"></div>
    `;

    const grid = el.querySelector('.chunk-blocks-grid');
    if (fill) grid.classList.add('chunk-blocks-grid--fill');
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
      fill,
      gridGap,
      gridPadding,
    };

    if (fill) this.bindGridReflow(instance);
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
    this.unbindGridReflow(instance);
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
