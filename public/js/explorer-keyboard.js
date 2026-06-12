/**
 * Desktop-grade keyboard navigation for file explorer.
 */
const ExplorerKeyboard = {
  focusIndex: -1,

  init() {
    document.addEventListener('keydown', (e) => this.handle(e));
    document.getElementById('file-grid')?.addEventListener('focusin', (e) => {
      const item = e.target.closest('.file-item');
      if (!item) return;
      const items = this.visibleItems();
      this.focusIndex = items.indexOf(item);
    });
  },

  visibleItems() {
    return [...document.querySelectorAll('#file-grid .file-item')];
  },

  isTyping() {
    const t = document.activeElement?.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT'
      || document.getElementById('cmd-palette')?.classList.contains('hidden') === false
      || document.getElementById('global-search')?.classList.contains('hidden') === false
      || document.getElementById('upload-center')?.classList.contains('hidden') === false
      || document.getElementById('media-viewer')?.classList.contains('hidden') === false
      || GlobalSearch?.open;
  },

  handle(e) {
    if (this.isTyping()) return;
    if (!explorer || explorer.renamingId) return;

    const items = this.visibleItems();
    const ctrl = e.ctrlKey || e.metaKey;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!items.length) return;
      e.preventDefault();
      const cols = VirtualGrid?.isListMode?.() ? 1 : (VirtualGrid?.getColumns?.() || 1);
      let delta = 0;
      if (e.key === 'ArrowDown') delta = e.shiftKey ? 1 : cols;
      else if (e.key === 'ArrowUp') delta = e.shiftKey ? -1 : -cols;
      else if (e.key === 'ArrowRight') delta = 1;
      else if (e.key === 'ArrowLeft') delta = -1;

      if (this.focusIndex < 0) this.focusIndex = 0;
      else this.focusIndex = Math.max(0, Math.min(items.length - 1, this.focusIndex + delta));

      const el = items[this.focusIndex];
      const file = explorer.files.find((f) => f.id === el?.dataset?.id);
      if (!file) return;

      if (e.shiftKey && this.focusIndex >= 0) {
        explorer.selected.add(file.id);
      } else if (ctrl) {
        if (explorer.selected.has(file.id)) explorer.selected.delete(file.id);
        else explorer.selected.add(file.id);
      } else {
        explorer.selected.clear();
        explorer.selected.add(file.id);
      }
      explorer.updateSelectionClasses();
      explorer.updateToolbar();
      explorer.updateStatus();
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }

    if (e.key === ' ' && explorer.selected.size === 1) {
      e.preventDefault();
      const id = [...explorer.selected][0];
      const file = explorer.files.find((f) => f.id === id);
      if (file && !file.is_folder && !file.pending) explorer.openItem(file);
      return;
    }

    if (e.key === 'Enter' && explorer.selected.size === 1) {
      e.preventDefault();
      const id = [...explorer.selected][0];
      const file = explorer.files.find((f) => f.id === id);
      if (file) explorer.openItem(file);
      return;
    }

    if (ctrl && e.key === 'c' && explorer.selected.size > 0) {
      const names = explorer.files
        .filter((f) => explorer.selected.has(f.id))
        .map((f) => f.name)
        .join('\n');
      navigator.clipboard?.writeText(names).catch(() => {});
      e.preventDefault();
      return;
    }

    if (ctrl && e.key === 'a') {
      e.preventDefault();
      explorer.selectAll();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (explorer.selected.size > 0) {
        if (explorer.isCuratedBrowseView() && explorer.viewMode !== 'playlist-detail' && explorer.viewMode !== 'collection-detail') {
          return;
        }
        e.preventDefault();
        explorer.deleteSelected();
      }
      return;
    }

    if (e.key === 'F2' && explorer.selected.size === 1) {
      e.preventDefault();
      const id = [...explorer.selected][0];
      const file = explorer.files.find((f) => f.id === id);
      if (file && !file.pending) explorer.startRename(file);
    }
  },
};
