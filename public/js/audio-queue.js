/**
 * Folder-aware audio queue — next/prev/shuffle/repeat
 */
const AudioQueue = {
  items: [],
  index: -1,
  shuffle: false,
  repeat: 'off',
  shuffledOrder: [],

  setFromFolder(files, startFile) {
    this.items = files.filter((f) => {
      const ext = f.name.split('.').pop().toLowerCase();
      return !f.is_folder && ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(ext);
    });
    this.index = this.items.findIndex((f) => f.id === startFile?.id);
    if (this.index < 0) this.index = 0;
    this.shuffledOrder = this.items.map((_, i) => i);
  },

  current() {
    if (!this.items.length || this.index < 0) return null;
    return this.items[this.index];
  },

  next() {
    if (!this.items.length) return null;
    if (this.shuffle) {
      const pos = this.shuffledOrder.indexOf(this.index);
      const nextPos = (pos + 1) % this.shuffledOrder.length;
      this.index = this.shuffledOrder[nextPos];
    } else if (this.index < this.items.length - 1) {
      this.index += 1;
    } else if (this.repeat === 'all') {
      this.index = 0;
    } else {
      return null;
    }
    return this.current();
  },

  previous() {
    if (!this.items.length) return null;
    if (this.shuffle) {
      const pos = this.shuffledOrder.indexOf(this.index);
      const prevPos = (pos - 1 + this.shuffledOrder.length) % this.shuffledOrder.length;
      this.index = this.shuffledOrder[prevPos];
    } else if (this.index > 0) {
      this.index -= 1;
    } else if (this.repeat === 'all') {
      this.index = this.items.length - 1;
    } else {
      return null;
    }
    return this.current();
  },

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle) {
      this.shuffledOrder = this.items.map((_, i) => i);
      for (let i = this.shuffledOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.shuffledOrder[i], this.shuffledOrder[j]] = [this.shuffledOrder[j], this.shuffledOrder[i]];
      }
    }
    return this.shuffle;
  },

  cycleRepeat() {
    const modes = ['off', 'all', 'one'];
    const idx = modes.indexOf(this.repeat);
    this.repeat = modes[(idx + 1) % modes.length];
    return this.repeat;
  },
};
