import { spawnSync } from 'node:child_process';

export function runOcr(imagePaths, config = {}, warnings = [], { spawnSyncImpl = spawnSync } = {}) {
  if (!imagePaths.length) return [];
  if (!config.provider || config.provider === 'none') {
    warnings.push('Xiaohongshu screenshot OCR disabled; unresolved image claims must stay out of the digest');
    return [];
  }
  if (config.provider !== 'tesseract') throw new Error('Supported OCR providers: none, tesseract');
  const languages = config.languages ?? 'eng+chi_sim+chi_tra';
  if (!/^[a-z_]+(?:\+[a-z_]+)*$/.test(languages)) throw new Error('Invalid Tesseract language list');
  return imagePaths.map(imagePath => {
    const result = spawnSyncImpl(config.binary ?? 'tesseract', [imagePath, 'stdout', '-l', languages, '--psm', '6'], {
      encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024, shell: false,
    });
    if (result.status !== 0) {
      warnings.push(`Tesseract failed for ${imagePath}; no OCR evidence accepted`);
      return { path: imagePath, ok: false, error: 'OCR process failed' };
    }
    const text = String(result.stdout ?? '').trim();
    return { path: imagePath, ok: true, text, lines: text.split(/\r?\n/).filter(Boolean).map(text => ({ text, confidence: null })) };
  });
}
