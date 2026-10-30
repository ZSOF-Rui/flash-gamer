const AD_HOSTS = [
  'googlesyndication.com', 'doubleclick.net', 'googleadservices.com', 'googletagmanager.com',
  'google-analytics.com', 'cpro.baidu.com', 'pos.baidu.com', 'tanx.com', 'mmstat.com',
  'cnzz.com', '51.la', 'umeng.com', 'umengcloud.com', 'ipinyou.com', 'mediav.com',
  'allyes.com', 'admaster.com.cn', 'miaozhen.com', 'irs01.com', 'adservice.google.com',
  'stat.api.4399.com', 'cdn.comment.4399pk.com', 'comment.4399pk.com', 'click.5054399.com',
  'stat.7k7k.com', 'union.7k7k.com'
];

function isBlockedHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  return AD_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

// 4399 的预加载壳由控制器 SWF 驱动；只放行控制器本身和版本清单，广告 SWF 继续拦
const PRELOADER_ALLOW = [
  /^https?:\/\/cdn\.comment\.4399pk\.com\/control\/[\w.-]+\.swf$/i,
  /^https?:\/\/cdn\.comment\.4399pk\.com\/control\/zwsf2-3\.gif$/i,
  /^https?:\/\/stat\.api\.4399\.com\/flash_(?:ctrl|ad)_version\.xml$/i
];

function isBlockedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (PRELOADER_ALLOW.some((re) => re.test(u.href.split('?')[0]))) return false;
    return isBlockedHost(u.hostname);
  } catch {
    return false;
  }
}

module.exports = { AD_HOSTS, isBlockedHost, isBlockedUrl };
