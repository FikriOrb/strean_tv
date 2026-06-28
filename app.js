/**
 * StreamVortex — World IPTV & M3U8 Stream Player
 * Core Application Module
 */

// ============ M3U Parser ============
class M3UParser {
    static parse(text) {
        const channels = [];
        const lines = text.split(/\r?\n/);
        let current = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('#EXTINF:')) {
                current = this._parseExtInf(line);
            } else if (current && line && !line.startsWith('#')) {
                current.url = line;
                current.id = channels.length;
                channels.push(current);
                current = null;
            }
        }
        return channels;
    }
    static _parseExtInf(line) {
        const get = (attr) => { const m = line.match(new RegExp(`${attr}="([^"]*)"`, 'i')); return m ? m[1] : ''; };
        const nameMatch = line.match(/,(.+)$/);
        return {
            name: nameMatch ? nameMatch[1].trim() : 'Unknown',
            logo: get('tvg-logo'),
            group: get('group-title') || 'Uncategorized',
            tvgId: get('tvg-id'),
            tvgName: get('tvg-name'),
            url: '',
            id: 0
        };
    }
}

// ============ Storage Manager ============
class StorageManager {
    static KEY_CHANNELS = 'sv_channels';
    static KEY_FAVORITES = 'sv_favorites';
    static KEY_HISTORY = 'sv_history';
    static KEY_VOLUME = 'sv_volume';

    static save(key, data) {
        try { localStorage.setItem(key, JSON.stringify(data)); } catch(e) { console.warn('Storage save failed:', e); }
    }
    static load(key, fallback = null) {
        try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : fallback; } catch(e) { return fallback; }
    }
    static saveChannels(ch) { this.save(this.KEY_CHANNELS, ch); }
    static loadChannels() { return this.load(this.KEY_CHANNELS, []); }
    static getFavorites() { return new Set(this.load(this.KEY_FAVORITES, [])); }
    static saveFavorites(set) { this.save(this.KEY_FAVORITES, [...set]); }
    static getHistory() { return this.load(this.KEY_HISTORY, []); }
    static addHistory(ch) {
        let h = this.getHistory().filter(c => c.url !== ch.url);
        h.unshift({ name: ch.name, url: ch.url, logo: ch.logo, group: ch.group, id: ch.id, time: Date.now() });
        if (h.length > 50) h = h.slice(0, 50);
        this.save(this.KEY_HISTORY, h);
    }
}

// ============ CORS Proxy Manager ============
class CorsProxy {
    // Multiple proxies for redundancy
    static PROXIES = [
        (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
        (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    ];
    static wrap(url, index = 0) {
        if (index >= this.PROXIES.length) return null;
        return this.PROXIES[index](url);
    }
    static count() { return this.PROXIES.length; }

    /**
     * Create a custom HLS.js loader class that proxies ALL requests
     * (manifest, level playlists, fragments, keys) through a CORS proxy.
     */
    static createProxiedLoaderClass(proxyIndex) {
        const proxyFn = this.PROXIES[proxyIndex];
        if (!proxyFn) return null;

        class ProxiedLoader extends Hls.DefaultConfig.loader {
            constructor(config) {
                super(config);
                const originalLoad = this.load.bind(this);
                this.load = function(context, config, callbacks) {
                    // Proxy the URL for all request types
                    const originalUrl = context.url;
                    // Don't double-proxy if already proxied
                    if (!originalUrl.includes('allorigins.win') &&
                        !originalUrl.includes('corsproxy.io') &&
                        !originalUrl.includes('codetabs.com')) {
                        context.url = proxyFn(originalUrl);
                    }
                    originalLoad(context, config, callbacks);
                };
            }
        }
        return ProxiedLoader;
    }
}

// ============ Player Engine (Multi-Strategy) ============
class PlayerEngine {
    constructor(videoEl) {
        this.video = videoEl;
        this.hls = null;
        this.dashPlayer = null;
        this.currentUrl = '';
        this.strategyIndex = 0;
        this.retryTimer = null;
        this.loadTimeout = null;
        this.onStatusChange = null;
        this.onError = null;
        this.onLevelLoaded = null;
        this.isPlaying = false;

        // Non-HLS extensions that should use native <video> directly
        this.NATIVE_EXTS = ['.mp4', '.webm', '.ogg', '.ogv', '.mkv', '.avi', '.ts'];
    }

    /**
     * Build ordered list of playback strategies for a given URL.
     * Strategy types:
     *   'hls'           — Direct HLS.js (no proxy)
     *   'hls-fullproxy' — HLS.js with ALL requests proxied
     *   'dash'          — MPEG-DASH via dash.js (direct)
     *   'dash-proxied'  — MPEG-DASH via dash.js (through CORS proxy)
     *   'native'        — Native <video src="...">
     */
    _buildStrategies(url) {
        const strategies = [];
        const urlLower = url.toLowerCase().split('?')[0];
        const isNative = this.NATIVE_EXTS.some(ext => urlLower.endsWith(ext));
        const isDASH = urlLower.endsWith('.mpd');
        const hasDashJs = typeof dashjs !== 'undefined';

        if (isNative) {
            strategies.push({ type: 'native', url, label: 'Direct native' });
            for (let i = 0; i < CorsProxy.count(); i++) {
                const proxied = CorsProxy.wrap(url, i);
                if (proxied) strategies.push({ type: 'native', url: proxied, label: `Proxy ${i + 1} native` });
            }
        } else if (isDASH && hasDashJs) {
            // MPEG-DASH streams: try dash.js direct, then proxied
            strategies.push({ type: 'dash', url, label: 'Direct DASH' });
            for (let i = 0; i < CorsProxy.count(); i++) {
                const proxied = CorsProxy.wrap(url, i);
                if (proxied) strategies.push({ type: 'dash-proxied', url: proxied, label: `Proxy ${i + 1} DASH` });
            }
            // Also try native fallback
            strategies.push({ type: 'native', url, label: 'Direct native' });
        } else {
            // HLS streams
            if (Hls.isSupported()) {
                strategies.push({ type: 'hls', url, label: 'Direct HLS', proxyIndex: -1 });
                for (let i = 0; i < CorsProxy.count(); i++) {
                    strategies.push({ type: 'hls-fullproxy', url, label: `Full-Proxy ${i + 1} HLS`, proxyIndex: i });
                }
            }
            // If it could also be DASH (no extension match), try DASH too
            if (hasDashJs) {
                strategies.push({ type: 'dash', url, label: 'Direct DASH (fallback)' });
                for (let i = 0; i < CorsProxy.count(); i++) {
                    const proxied = CorsProxy.wrap(url, i);
                    if (proxied) strategies.push({ type: 'dash-proxied', url: proxied, label: `Proxy ${i + 1} DASH` });
                }
            }
            // Native fallback
            strategies.push({ type: 'native', url, label: 'Direct native' });
            for (let i = 0; i < CorsProxy.count(); i++) {
                const proxied = CorsProxy.wrap(url, i);
                if (proxied) strategies.push({ type: 'native', url: proxied, label: `Proxy ${i + 1} native` });
            }
        }
        return strategies;
    }

    play(url) {
        this.stop();
        this.currentUrl = url;
        this.strategies = this._buildStrategies(url);
        this.strategyIndex = 0;
        this.isPlaying = true;
        console.log(`[Player] ${this.strategies.length} strategies for: ${url.substring(0, 80)}...`);
        this._tryNextStrategy();
    }

    _tryNextStrategy() {
        if (!this.isPlaying) return;
        if (this.strategyIndex >= this.strategies.length) {
            if (this.onError) this.onError('Stream unavailable — all connection methods failed. The channel may be offline or geo-restricted.');
            return;
        }

        const strat = this.strategies[this.strategyIndex];
        console.log(`[Player] Trying strategy ${this.strategyIndex + 1}/${this.strategies.length}: ${strat.label}`);
        this._setStatus('buffering');

        // Cleanup previous attempt
        this._cleanup();

        // Timeout per strategy
        const TIMEOUT_MS = 15000;
        this.loadTimeout = setTimeout(() => {
            console.warn(`[Player] Strategy "${strat.label}" timed out`);
            this.strategyIndex++;
            this._tryNextStrategy();
        }, TIMEOUT_MS);

        if (strat.type === 'hls') {
            this._tryHLS(strat, null);
        } else if (strat.type === 'hls-fullproxy') {
            const LoaderClass = CorsProxy.createProxiedLoaderClass(strat.proxyIndex);
            this._tryHLS(strat, LoaderClass);
        } else if (strat.type === 'dash' || strat.type === 'dash-proxied') {
            this._tryDASH(strat);
        } else {
            this._tryNative(strat);
        }
    }

    _tryHLS(strat, customLoaderClass) {
        try {
            const hlsConfig = {
                enableWorker: true,
                lowLatencyMode: true,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                manifestLoadingTimeOut: 12000,
                manifestLoadingMaxRetry: 1,
                levelLoadingTimeOut: 12000,
                levelLoadingMaxRetry: 1,
                fragLoadingTimeOut: 20000,
                fragLoadingMaxRetry: 2,
                xhrSetup: (xhr) => {
                    xhr.withCredentials = false;
                }
            };

            // If we have a custom loader, use it to proxy ALL requests
            if (customLoaderClass) {
                hlsConfig.loader = customLoaderClass;
            }

            this.hls = new Hls(hlsConfig);
            this.hls.loadSource(strat.url);
            this.hls.attachMedia(this.video);

            this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                clearTimeout(this.loadTimeout);
                this.video.play().catch(() => {});
                this._setStatus('live');
                console.log(`[Player] ✓ Playing via: ${strat.label}`);
            });

            this.hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
                if (this.onLevelLoaded) this.onLevelLoaded(data);
            });

            this.hls.on(Hls.Events.FRAG_BUFFERED, () => {
                clearTimeout(this.loadTimeout);
                this._setStatus('live');
            });

            this.hls.on(Hls.Events.ERROR, (_, data) => {
                if (data.fatal) {
                    console.warn(`[Player] HLS fatal error on "${strat.label}": ${data.type}/${data.details}`);
                    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !strat._mediaRecoveryAttempted) {
                        strat._mediaRecoveryAttempted = true;
                        console.log(`[Player] Attempting media error recovery...`);
                        this.hls.recoverMediaError();
                        return;
                    }
                    clearTimeout(this.loadTimeout);
                    this.strategyIndex++;
                    this._tryNextStrategy();
                }
            });
        } catch (e) {
            console.warn(`[Player] HLS exception on "${strat.label}":`, e);
            clearTimeout(this.loadTimeout);
            this.strategyIndex++;
            this._tryNextStrategy();
        }
    }

    _tryNative(strat) {
        try {
            const onCanPlay = () => {
                clearTimeout(this.loadTimeout);
                this.video.play().catch(() => {});
                this._setStatus('live');
                console.log(`[Player] ✓ Playing via: ${strat.label}`);
                this.video.removeEventListener('canplay', onCanPlay);
                this.video.removeEventListener('error', onError);
            };

            const onError = () => {
                console.warn(`[Player] Native error on "${strat.label}"`);
                this.video.removeEventListener('canplay', onCanPlay);
                this.video.removeEventListener('error', onError);
                clearTimeout(this.loadTimeout);
                this.strategyIndex++;
                this._tryNextStrategy();
            };

            this.video.addEventListener('canplay', onCanPlay);
            this.video.addEventListener('error', onError);
            this.video.src = strat.url;
            this.video.load();
        } catch (e) {
            console.warn(`[Player] Native exception on "${strat.label}":`, e);
            clearTimeout(this.loadTimeout);
            this.strategyIndex++;
            this._tryNextStrategy();
        }
    }

    _tryDASH(strat) {
        try {
            this.dashPlayer = dashjs.MediaPlayer().create();
            this.dashPlayer.updateSettings({
                streaming: {
                    abr: { autoSwitchBitrate: { video: true, audio: true } },
                    retryAttempts: { MPD: 2, MediaSegment: 2 },
                    retryIntervals: { MPD: 2000, MediaSegment: 2000 }
                }
            });

            this.dashPlayer.initialize(this.video, strat.url, true);

            // Listen for successful playback
            const onCanPlay = () => {
                clearTimeout(this.loadTimeout);
                this._setStatus('live');
                console.log(`[Player] ✓ Playing via: ${strat.label}`);
                this.video.removeEventListener('canplay', onCanPlay);
            };
            this.video.addEventListener('canplay', onCanPlay);

            // Listen for DASH errors
            this.dashPlayer.on(dashjs.MediaPlayer.events.ERROR, (e) => {
                console.warn(`[Player] DASH error on "${strat.label}":`, e.error || e);
                this.video.removeEventListener('canplay', onCanPlay);
                clearTimeout(this.loadTimeout);
                this.strategyIndex++;
                this._tryNextStrategy();
            });

            this.dashPlayer.on(dashjs.MediaPlayer.events.PLAYBACK_ERROR, (e) => {
                console.warn(`[Player] DASH playback error on "${strat.label}":`, e);
                this.video.removeEventListener('canplay', onCanPlay);
                clearTimeout(this.loadTimeout);
                this.strategyIndex++;
                this._tryNextStrategy();
            });

        } catch (e) {
            console.warn(`[Player] DASH exception on "${strat.label}":`, e);
            clearTimeout(this.loadTimeout);
            this.strategyIndex++;
            this._tryNextStrategy();
        }
    }

    _cleanup() {
        if (this.hls) { try { this.hls.destroy(); } catch(e) {} this.hls = null; }
        if (this.dashPlayer) { try { this.dashPlayer.reset(); } catch(e) {} this.dashPlayer = null; }
        this.video.removeAttribute('src');
        try { this.video.load(); } catch(e) {}
    }

    stop() {
        this.isPlaying = false;
        clearTimeout(this.retryTimer);
        clearTimeout(this.loadTimeout);
        this._cleanup();
    }

    retry() {
        if (this.currentUrl) this.play(this.currentUrl);
    }

    _setStatus(s) { if (this.onStatusChange) this.onStatusChange(s); }

    getStats() {
        const stats = {
            resolution: '—', bitrate: '—', buffer: '—', latency: '—'
        };
        if (this.hls) {
            const levels = this.hls.levels;
            const cur = this.hls.currentLevel;
            const level = levels && levels[cur];
            if (level) {
                stats.resolution = `${level.width}x${level.height}`;
                stats.bitrate = `${Math.round(level.bitrate / 1000)} kbps`;
            }
            if (this.hls.latency != null) stats.latency = `${this.hls.latency.toFixed(1)}s`;
        }
        if (this.video.videoWidth) {
            stats.resolution = `${this.video.videoWidth}x${this.video.videoHeight}`;
        }
        if (this.video.buffered.length) {
            try {
                stats.buffer = `${(this.video.buffered.end(this.video.buffered.length - 1) - this.video.currentTime).toFixed(1)}s`;
            } catch(e) {}
        }
        return stats;
    }
}

// ============ App Controller ============
class App {
    constructor() {
        this.channels = [];
        this.groups = {};
        this.favorites = StorageManager.getFavorites();
        this.currentChannel = null;
        this.currentTab = 'groups';
        this.searchQuery = '';
        this.expandedGroups = new Set();

        // DOM refs
        this.$ = (id) => document.getElementById(id);
        this.video = this.$('video-player');
        this.player = new PlayerEngine(this.video);

        this._bindEvents();
        this._loadSaved();
        this._setupPlayerCallbacks();
        this._startStatsLoop();

        // Splash
        setTimeout(() => { this.$('app').classList.remove('hidden'); }, 2000);
        setTimeout(() => { const s = this.$('splash-screen'); if (s) s.remove(); }, 2500);

        // Restore volume
        const vol = StorageManager.load(StorageManager.KEY_VOLUME, 0.8);
        this.video.volume = vol;
        this.$('volume-slider').value = vol;
    }

    _bindEvents() {
        // Import
        this.$('btn-import-url').onclick = () => this._showModal();
        this.$('btn-import-file').onclick = () => this.$('file-input').click();
        this.$('file-input').onchange = (e) => this._importFile(e);
        this.$('btn-modal-cancel').onclick = () => this._hideModal();
        this.$('btn-modal-load').onclick = () => this._importUrl();
        this.$('modal-url').querySelector('.modal-backdrop').onclick = () => this._hideModal();
        this.$('url-input').onkeydown = (e) => { if (e.key === 'Enter') this._importUrl(); };

        // Sidebar
        this.$('btn-collapse-sidebar').onclick = () => this._toggleSidebar(true);
        this.$('btn-expand-sidebar').onclick = () => this._toggleSidebar(false);

        // Search
        this.$('search-input').oninput = (e) => { this.searchQuery = e.target.value.toLowerCase(); this._renderChannels(); };

        // Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentTab = btn.dataset.tab;
                this._renderChannels();
            };
        });

        // Meta tabs
        document.querySelectorAll('.meta-tab').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.meta-tab').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.meta-panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                this.$('meta-' + btn.dataset.meta).classList.add('active');
            };
        });

        // Player controls
        this.$('btn-play').onclick = () => this._togglePlay();
        this.$('btn-mute').onclick = () => this._toggleMute();
        this.$('volume-slider').oninput = (e) => { this.video.volume = parseFloat(e.target.value); this.video.muted = false; this._updateMuteIcon(); StorageManager.save(StorageManager.KEY_VOLUME, this.video.volume); };
        this.$('btn-fullscreen').onclick = () => this._toggleFullscreen();
        this.$('btn-pip').onclick = () => this._togglePiP();
        this.$('btn-theater').onclick = () => this._toggleTheater();
        this.$('btn-retry').onclick = () => { this.$('error-overlay').classList.add('hidden'); this.player.retry(); };
        this.$('btn-fav').onclick = () => this._toggleFavorite();

        // Video events
        this.video.onplay = () => this._updatePlayIcon(true);
        this.video.onpause = () => this._updatePlayIcon(false);
        this.video.onwaiting = () => this.player._setStatus('buffering');
        this.video.onplaying = () => this.player._setStatus('live');

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT') return;
            switch (e.key.toLowerCase()) {
                case ' ': e.preventDefault(); this._togglePlay(); break;
                case 'f': this._toggleFullscreen(); break;
                case 't': this._toggleTheater(); break;
                case 'p': this._togglePiP(); break;
                case 'm': this._toggleMute(); break;
                case 'arrowup': e.preventDefault(); this._channelNav(-1); break;
                case 'arrowdown': e.preventDefault(); this._channelNav(1); break;
                case 'escape': this._hideModal(); break;
            }
        });

        // Drag and drop
        document.addEventListener('dragover', (e) => e.preventDefault());
        document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) this._readFile(f); });
    }

    _setupPlayerCallbacks() {
        this.player.onStatusChange = (status) => {
            const el = this.$('stream-status');
            el.classList.remove('hidden', 'buffering', 'offline');
            el.querySelector('.status-text').textContent = status === 'live' ? 'Live' : status === 'buffering' ? 'Buffering...' : 'Offline';
            if (status !== 'live') el.classList.add(status);
            this.$('ambient-glow').classList.toggle('active', status === 'live');
        };
        this.player.onError = (msg) => {
            this.$('error-overlay').classList.remove('hidden');
            this.$('stream-status').classList.remove('hidden');
            this.$('stream-status').classList.add('offline');
            this.$('stream-status').querySelector('.status-text').textContent = 'Offline';
            
            // Default generic error
            this.$('error-icon-generic').classList.remove('hidden');
            this.$('error-icon-vpn').classList.add('hidden');
            this.$('error-message').textContent = msg || 'Stream unavailable';
            this.$('vpn-recommendation').classList.add('hidden');
            
            // Detect Geo-Block and recommend VPN
            if (this.currentChannel) {
                const recommendation = this._detectGeoBlock(this.currentChannel);
                if (recommendation) {
                    this.$('error-icon-generic').classList.add('hidden');
                    this.$('error-icon-vpn').classList.remove('hidden');
                    this.$('error-message').textContent = 'Channel is Geo-Blocked';
                    this.$('vpn-recommendation').textContent = recommendation;
                    this.$('vpn-recommendation').classList.remove('hidden');
                    this.$('btn-retry').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg> I have connected VPN (Retry)';
                } else {
                    this.$('btn-retry').textContent = 'Retry Connection';
                }
            }
        };
    }

    /**
     * Smart VPN Recommendation Engine
     */
    _detectGeoBlock(channel) {
        const title = (channel.name || channel.title || '').toLowerCase();
        const group = (channel.group || '').toLowerCase();
        
        // Check explicit tags
        const isGeoBlocked = title.includes('geo-blocked') || title.includes('geoblocked') || group.includes('geo-blocked');
        
        // Guess country from name for targeted recommendations
        let suggestedRegion = 'the correct region';
        
        if (title.includes('japan') || title.includes('animax') || title.includes('nhk')) suggestedRegion = 'Japan 🇯🇵';
        else if (title.includes('uk') || title.includes('bbc') || title.includes('itv')) suggestedRegion = 'United Kingdom 🇬🇧';
        else if (title.includes('us') || title.includes('usa') || title.includes('cnn') || title.includes('fox')) suggestedRegion = 'United States 🇺🇸';
        else if (title.includes('france') || title.includes('tf1')) suggestedRegion = 'France 🇫🇷';
        else if (title.includes('korea') || title.includes('kbs') || title.includes('sbs')) suggestedRegion = 'South Korea 🇰🇷';
        else if (title.includes('germany') || title.includes('zdf') || title.includes('ard')) suggestedRegion = 'Germany 🇩🇪';
        
        if (isGeoBlocked || suggestedRegion !== 'the correct region') {
            return `Please turn on your VPN app and connect to ${suggestedRegion} to watch this channel.`;
        }
        
        return null;
    }

    // ---- Import ----
    _showModal() { this.$('modal-url').classList.remove('hidden'); this.$('url-input').value = ''; this.$('url-input').focus(); this.$('import-progress').classList.add('hidden'); }
    _hideModal() { this.$('modal-url').classList.add('hidden'); }

    async _importUrl() {
        const url = this.$('url-input').value.trim();
        if (!url) return;
        this.$('import-progress').classList.remove('hidden');
        this.$('progress-fill').style.width = '30%';
        this.$('progress-text').textContent = 'Fetching playlist...';
        try {
            // Try direct fetch first, then CORS proxy fallback
            let text;
            try {
                const res = await fetch(url);
                text = await res.text();
            } catch {
                const proxy = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
                const res = await fetch(proxy);
                text = await res.text();
            }
            this.$('progress-fill').style.width = '70%';
            this.$('progress-text').textContent = 'Parsing channels...';
            setTimeout(() => {
                this._processM3U(text);
                this.$('progress-fill').style.width = '100%';
                this.$('progress-text').textContent = `Loaded ${this.channels.length} channels`;
                setTimeout(() => this._hideModal(), 800);
            }, 100);
        } catch (e) {
            this.$('progress-text').textContent = 'Error: ' + e.message;
            this.$('progress-fill').style.width = '0%';
        }
    }

    _importFile(e) { const f = e.target.files[0]; if (f) this._readFile(f); e.target.value = ''; }
    _readFile(file) {
        const reader = new FileReader();
        reader.onload = (ev) => this._processM3U(ev.target.result);
        reader.readAsText(file);
    }

    _processM3U(text) {
        this.channels = M3UParser.parse(text);
        this.groups = {};
        this.channels.forEach(ch => {
            if (!this.groups[ch.group]) this.groups[ch.group] = [];
            this.groups[ch.group].push(ch);
        });
        StorageManager.saveChannels(this.channels);
        this.$('channel-count-label').textContent = `${this.channels.length} channels`;
        this.$('empty-state').classList.toggle('hidden', this.channels.length > 0);
        this._renderChannels();
    }

    _loadSaved() {
        const saved = StorageManager.loadChannels();
        if (saved.length) {
            this.channels = saved;
            this._processLoaded();
        } else {
            // First launch — auto-load default channels
            this._loadDefaults();
        }
    }

    async _loadDefaults() {
        if (typeof loadDefaultChannels !== 'function') return;

        // Show loading state in sidebar
        const emptyState = this.$('empty-state');
        emptyState.innerHTML = `
            <div class="splash-logo" style="margin-bottom:8px">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="22" stroke="#38BDF8" stroke-width="2" stroke-dasharray="6 4"><animateTransform attributeName="transform" type="rotate" from="0 24 24" to="360 24 24" dur="2s" repeatCount="indefinite"/></circle></svg>
            </div>
            <p style="font-size:14px;color:#F3F4F6;font-weight:600">Loading World TV Channels...</p>
            <span id="default-load-progress" class="empty-hint">Preparing playlists...</span>
            <div style="width:80%;margin-top:12px">
                <div class="progress-bar"><div id="default-progress-fill" class="progress-fill" style="width:0%"></div></div>
            </div>
        `;

        try {
            const channels = await loadDefaultChannels((loaded, total, channelCount) => {
                const pct = Math.round((loaded / total) * 100);
                const progressEl = this.$('default-progress-fill');
                const textEl = this.$('default-load-progress');
                if (progressEl) progressEl.style.width = pct + '%';
                if (textEl) textEl.textContent = `Loading category ${loaded}/${total} — ${channelCount} channels found`;
            });

            if (channels.length > 0) {
                this.channels = channels;
                this.groups = {};
                this.channels.forEach(ch => {
                    if (!this.groups[ch.group]) this.groups[ch.group] = [];
                    this.groups[ch.group].push(ch);
                });
                StorageManager.saveChannels(this.channels);
                this.$('channel-count-label').textContent = `${this.channels.length} channels`;
                emptyState.classList.add('hidden');
                this._renderChannels();
                console.log(`[App] Default channels loaded: ${this.channels.length}`);
            }
        } catch (e) {
            console.error('[App] Failed to load default channels:', e);
            emptyState.innerHTML = `
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#38BDF8" stroke-width="1"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                <p>Could not load default channels</p>
                <span class="empty-hint">Import an M3U playlist manually</span>
            `;
        }
    }

    _processLoaded() {
        this.groups = {};
        this.channels.forEach(ch => {
            if (!this.groups[ch.group]) this.groups[ch.group] = [];
            this.groups[ch.group].push(ch);
        });
        this.$('channel-count-label').textContent = `${this.channels.length} channels`;
        this.$('empty-state').classList.toggle('hidden', this.channels.length > 0);
        this._renderChannels();
    }

    // ---- Rendering ----
    _renderChannels() {
        const container = this.$('channel-list-container');
        const groupList = this.$('group-list');
        const channelList = this.$('channel-list');
        groupList.innerHTML = '';
        channelList.innerHTML = '';

        if (this.currentTab === 'favorites') return this._renderFavorites(channelList);
        if (this.currentTab === 'history') return this._renderHistory(channelList);

        let filtered = this.channels;
        if (this.searchQuery) {
            filtered = this.channels.filter(ch =>
                ch.name.toLowerCase().includes(this.searchQuery) ||
                ch.group.toLowerCase().includes(this.searchQuery)
            );
            this.$('search-count').classList.remove('hidden');
            this.$('search-count').textContent = filtered.length;
            // Flat list for search
            const frag = document.createDocumentFragment();
            this._renderChunkList(filtered, frag);
            channelList.appendChild(frag);
            return;
        }
        this.$('search-count').classList.add('hidden');

        // Group view
        const sortedGroups = Object.keys(this.groups).sort();
        const frag = document.createDocumentFragment();
        for (const gName of sortedGroups) {
            const channels = this.groups[gName];
            const item = document.createElement('div');
            item.className = 'group-item';
            const expanded = this.expandedGroups.has(gName);
            item.innerHTML = `
                <div class="group-header ${expanded ? 'expanded' : ''}">
                    <svg class="group-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
                    <span class="group-name">${this._esc(gName)}</span>
                    <span class="group-count">${channels.length}</span>
                </div>
                <div class="group-channels" style="display:${expanded ? 'block' : 'none'}"></div>
            `;
            const header = item.querySelector('.group-header');
            const chContainer = item.querySelector('.group-channels');
            header.onclick = () => {
                const isExp = this.expandedGroups.has(gName);
                if (isExp) this.expandedGroups.delete(gName); else this.expandedGroups.add(gName);
                header.classList.toggle('expanded');
                chContainer.style.display = isExp ? 'none' : 'block';
                if (!isExp && chContainer.children.length === 0) {
                    this._renderChunkList(channels, chContainer);
                }
            };
            if (expanded) this._renderChunkList(channels, chContainer);
            frag.appendChild(item);
        }
        groupList.appendChild(frag);
    }

    _renderChunkList(channels, container) {
        // Virtual-ish: render in chunks for large lists
        const CHUNK = 200;
        let idx = 0;
        const renderChunk = () => {
            const frag = document.createDocumentFragment();
            const end = Math.min(idx + CHUNK, channels.length);
            for (; idx < end; idx++) {
                frag.appendChild(this._createChannelEl(channels[idx]));
            }
            container.appendChild(frag);
            if (idx < channels.length) requestAnimationFrame(renderChunk);
        };
        renderChunk();
    }

    _createChannelEl(ch) {
        const el = document.createElement('div');
        el.className = 'channel-item' + (this.currentChannel && this.currentChannel.url === ch.url ? ' active' : '');
        const logoHtml = ch.logo
            ? `<img class="channel-logo" src="${this._esc(ch.logo)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : '';
        const placeholderDisplay = ch.logo ? 'none' : 'flex';
        const initial = ch.name.charAt(0).toUpperCase();
        el.innerHTML = `
            ${logoHtml}
            <div class="channel-logo-placeholder" style="display:${placeholderDisplay}">${initial}</div>
            <div class="channel-info">
                <div class="channel-name">${this._esc(ch.name)}</div>
                <div class="channel-group-tag">${this._esc(ch.group)}</div>
            </div>
            ${this.favorites.has(ch.url) ? '<span class="channel-fav-indicator">★</span>' : ''}
            <div class="equalizer"><span></span><span></span><span></span></div>
        `;
        el.onclick = () => this._playChannel(ch);
        return el;
    }

    _renderFavorites(container) {
        const favChannels = this.channels.filter(ch => this.favorites.has(ch.url));
        if (!favChannels.length) {
            container.innerHTML = '<div class="empty-state" style="height:auto;padding:40px"><p>No favorites yet</p><span class="empty-hint">Click the ★ icon on a channel to add it</span></div>';
            return;
        }
        this._renderChunkList(favChannels, container);
    }

    _renderHistory(container) {
        const history = StorageManager.getHistory();
        if (!history.length) {
            container.innerHTML = '<div class="empty-state" style="height:auto;padding:40px"><p>No watch history</p><span class="empty-hint">Channels you watch will appear here</span></div>';
            return;
        }
        this._renderChunkList(history, container);
    }

    // ---- Playback ----
    _playChannel(ch) {
        this.currentChannel = ch;
        this.$('player-overlay').classList.add('hidden');
        this.$('error-overlay').classList.add('hidden');
        this.$('stream-status').classList.remove('hidden');
        this.player.play(ch.url);

        // Update meta
        this.$('meta-name').textContent = ch.name;
        this.$('meta-group').textContent = ch.group;
        this.$('now-playing-label').textContent = ch.name;
        const logo = this.$('meta-logo');
        if (ch.logo) { logo.src = ch.logo; logo.hidden = false; } else { logo.hidden = true; }
        this.$('btn-fav').classList.toggle('active', this.favorites.has(ch.url));

        StorageManager.addHistory(ch);
        this._renderChannels();

        // On mobile, collapse sidebar
        if (window.innerWidth <= 900) this._toggleSidebar(true);
    }

    // ---- Controls ----
    _togglePlay() {
        if (!this.currentChannel) return;
        if (this.video.paused) this.video.play().catch(() => {}); else this.video.pause();
    }
    _updatePlayIcon(playing) {
        this.$('btn-play').querySelector('.icon-play').classList.toggle('hidden', playing);
        this.$('btn-play').querySelector('.icon-pause').classList.toggle('hidden', !playing);
    }
    _toggleMute() {
        this.video.muted = !this.video.muted;
        this._updateMuteIcon();
    }
    _updateMuteIcon() {
        this.$('btn-mute').querySelector('.icon-vol').classList.toggle('hidden', this.video.muted);
        this.$('btn-mute').querySelector('.icon-muted').classList.toggle('hidden', !this.video.muted);
    }
    _toggleFullscreen() {
        const el = this.$('player-container');
        if (!document.fullscreenElement) el.requestFullscreen().catch(() => {});
        else document.exitFullscreen().catch(() => {});
    }
    async _togglePiP() {
        try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            else await this.video.requestPictureInPicture();
        } catch (e) { console.warn('PiP failed:', e); }
    }
    _toggleTheater() {
        this.$('app').classList.toggle('theater');
    }
    _toggleSidebar(collapse) {
        const sidebar = document.querySelector('.sidebar');
        const expandBtn = this.$('btn-expand-sidebar');
        sidebar.classList.toggle('collapsed', collapse);
        expandBtn.classList.toggle('hidden', !collapse);
    }
    _toggleFavorite() {
        if (!this.currentChannel) return;
        const url = this.currentChannel.url;
        if (this.favorites.has(url)) this.favorites.delete(url);
        else this.favorites.add(url);
        StorageManager.saveFavorites(this.favorites);
        this.$('btn-fav').classList.toggle('active', this.favorites.has(url));
        this._renderChannels();
    }
    _channelNav(dir) {
        if (!this.channels.length) return;
        const curIdx = this.currentChannel ? this.channels.findIndex(c => c.url === this.currentChannel.url) : -1;
        let next = curIdx + dir;
        if (next < 0) next = this.channels.length - 1;
        if (next >= this.channels.length) next = 0;
        this._playChannel(this.channels[next]);
    }

    // ---- Stats Loop ----
    _startStatsLoop() {
        setInterval(() => {
            const stats = this.player.getStats();
            if (stats) {
                this.$('stat-resolution').textContent = stats.resolution;
                this.$('stat-bitrate').textContent = stats.bitrate;
                this.$('stat-buffer').textContent = stats.buffer;
                this.$('stat-latency').textContent = stats.latency;
            }
        }, 2000);
    }

    _esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }
}

// ---- Boot ----
document.addEventListener('DOMContentLoaded', () => new App());
