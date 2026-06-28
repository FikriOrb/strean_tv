/**
 * StreamVortex — Default Built-in Channels
 * Curated collection of free-to-air global TV channels
 * Sources: iptv-org community, public broadcaster streams
 */

const DEFAULT_PLAYLISTS = [
    // By category for faster loading
    'https://iptv-org.github.io/iptv/categories/news.m3u',
    'https://iptv-org.github.io/iptv/categories/entertainment.m3u',
    'https://iptv-org.github.io/iptv/categories/music.m3u',
    'https://iptv-org.github.io/iptv/categories/sports.m3u',
    'https://iptv-org.github.io/iptv/categories/kids.m3u',
    'https://iptv-org.github.io/iptv/categories/movies.m3u',
    'https://iptv-org.github.io/iptv/categories/documentary.m3u',
    'https://iptv-org.github.io/iptv/categories/animation.m3u',
    'https://iptv-org.github.io/iptv/categories/education.m3u',
    'https://iptv-org.github.io/iptv/categories/lifestyle.m3u',
    'https://iptv-org.github.io/iptv/categories/cooking.m3u',
    'https://iptv-org.github.io/iptv/categories/travel.m3u',
    'https://iptv-org.github.io/iptv/categories/science.m3u',
    'https://iptv-org.github.io/iptv/categories/business.m3u',
    'https://iptv-org.github.io/iptv/categories/classic.m3u',
    'https://iptv-org.github.io/iptv/categories/comedy.m3u',
    'https://iptv-org.github.io/iptv/categories/culture.m3u',
    'https://iptv-org.github.io/iptv/categories/outdoor.m3u',
    'https://iptv-org.github.io/iptv/categories/religious.m3u',
    'https://iptv-org.github.io/iptv/categories/shop.m3u',
    'https://iptv-org.github.io/iptv/categories/weather.m3u',
    'https://iptv-org.github.io/iptv/categories/general.m3u',
];

/**
 * Load all default playlists in parallel and merge into a single channel list.
 * Uses deduplication by URL to avoid duplicate entries from overlapping categories.
 * @returns {Promise<Array>} Array of parsed channel objects
 */
async function loadDefaultChannels(onProgress) {
    const allChannels = [];
    const seenUrls = new Set();
    let loaded = 0;
    const total = DEFAULT_PLAYLISTS.length;

    // Fetch all playlists in parallel (batched to avoid overwhelming)
    const BATCH_SIZE = 6;
    for (let i = 0; i < total; i += BATCH_SIZE) {
        const batch = DEFAULT_PLAYLISTS.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map(async (url) => {
                try {
                    let text;
                    try {
                        const res = await fetch(url);
                        text = await res.text();
                    } catch {
                        // Fallback to CORS proxy
                        const proxy = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
                        const res = await fetch(proxy);
                        text = await res.text();
                    }
                    return text;
                } catch (e) {
                    console.warn(`[Default] Failed to load: ${url}`, e);
                    return null;
                }
            })
        );

        for (const result of results) {
            loaded++;
            if (result.status === 'fulfilled' && result.value) {
                const channels = M3UParser.parse(result.value);
                for (const ch of channels) {
                    if (!seenUrls.has(ch.url)) {
                        seenUrls.add(ch.url);
                        ch.id = allChannels.length;
                        allChannels.push(ch);
                    }
                }
            }
            if (onProgress) onProgress(loaded, total, allChannels.length);
        }
    }

    console.log(`[Default] Loaded ${allChannels.length} unique channels from ${total} category playlists`);
    return allChannels;
}
