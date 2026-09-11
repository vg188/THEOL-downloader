export function createSelection() {
  const selected = new Set(); let scope;
  return {
    reset(key) { if (key !== scope) { scope = key; selected.clear(); } },
    clear() { selected.clear(); },
    toggle(id, checked) { if (checked) selected.add(id); else selected.delete(id); },
    toggleVisible(files, checked) { for (const file of files) { if (checked) selected.add(file.id); else selected.delete(file.id); } },
    visible(files, query = '', format = 'all') {
      const needle = query.normalize('NFC').trim().toLowerCase();
      return files.filter(file => (format === 'all' || file.extension === format) && file.name.normalize('NFC').toLowerCase().includes(needle));
    },
    selectedIds() { return [...selected]; },
  };
}
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** unit)).toFixed(unit ? 1 : 0)} ${['B','KB','MB','GB'][unit]}`;
}
