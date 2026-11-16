import { useState } from 'preact/hooks';
import { isWebUrl } from '../../shared/url';
import { PageIcon } from './icons';
/** The browser's own favicon cache (`favicon` permission): never a request to the website. */
export function faviconUrl(pageUrl: string): string {
  return chrome.runtime.getURL('/_favicon/?pageUrl=' + encodeURIComponent(pageUrl) + '&size=32');
}
/** 16px favicon for web pages; a local placeholder for everything else or when the image fails. */
export function Favicon({ url, size = 16 }: { url: string; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!isWebUrl(url) || failed === url) {
    return <span class="favicon favicon-placeholder" style={{ width: size, height: size }}><PageIcon size={size - 2} /></span>;
  }
  return (
    <img
      class="favicon" src={faviconUrl(url)} width={size} height={size} alt="" loading="lazy" decoding="async"
      onError={() => setFailed(url)}
    />
  );
}
