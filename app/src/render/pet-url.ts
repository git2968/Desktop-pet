/**
 * 把绝对文件路径转成 pet:// URL,需 host 区分(live2d / sprite)和资源根目录。
 * 浏览器侧没有 path 模块,直接用字符串切分(Windows 反斜杠 + 正斜杠都兼容)。
 */
export function toPetUrl(absPath: string, host: 'live2d' | 'sprite', baseDir: string): string {
  const a = absPath.replace(/\\/g, '/');
  const b = baseDir.replace(/\\/g, '/').replace(/\/$/, '');
  const rel = a.startsWith(b + '/') ? a.slice(b.length + 1) : a;
  const segs = rel.split('/').map(encodeURIComponent).join('/');
  return `pet://${host}/${segs}`;
}
