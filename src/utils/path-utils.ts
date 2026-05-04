/**
 * Given a JCR node path (which may be deep inside a page), walk up to find
 * the first ancestor whose primary type is cq:Page.
 * e.g. /content/mysite/en/home/jcr:content/root/text → /content/mysite/en/home
 */
export function extractPagePath(nodePath: string): string {
  // Strip jcr:content and everything after it
  const jcrIdx = nodePath.indexOf('/jcr:content');
  if (jcrIdx !== -1) return nodePath.substring(0, jcrIdx);
  return nodePath;
}

/**
 * Given an AEM page path, return the depth from a given root.
 * e.g. depth('/content/mysite/en/home', '/content') → 3
 */
export function pathDepth(path: string, root: string): number {
  const relative = path.replace(root, '').replace(/^\//, '');
  if (!relative) return 0;
  return relative.split('/').length;
}

/**
 * Determine if a path is a DAM asset path.
 */
export function isDamPath(path: string): boolean {
  return path.startsWith('/content/dam/');
}

/**
 * Encode a JCR path for use in a URL segment.
 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

/**
 * Given a set of candidate reference strings from page content,
 * filter down to those that look like valid internal JCR paths.
 */
export function isInternalPath(value: string): boolean {
  return typeof value === 'string' &&
    value.startsWith('/content') &&
    !value.includes('://') &&
    !value.startsWith('/content/cq:tags');
}
