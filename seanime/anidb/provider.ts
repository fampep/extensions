// ─── Types ────────────────────────────────────────────────────────────────────

type Ctx = { anilistId: number; episode: number }
type Lang = { code?: string; name?: string; embed_url?: string }
type SiteEpisode = { id: number; number: number; number2?: number | null; filler?: boolean }
type EpMeta = { epId: string; siteId: string; slug: string }

// ─────────────────────────────────────────────────────────────────────────────
//
//  AniDB (anidb.app) — Laravel frontend, session-cookie gated.
//
//  Flow:
//    1. GET /search/suggestions?q=…        (XHR)  → <a data-search-item> cards
//       fallback GET /browse?q=…           (nav)  → anime cards
//    2. GET /anime/{slug}                  (nav)  → warms session, sets referer
//    3. GET /api/frontend/anime/{id}/episodes     → { episodes: [{ id, number }] }
//    4. GET /api/frontend/episode/{id}/languages  → { languages: [{ code, name, embed_url }] }
//    5. GET {embed_url}                           → JWPlayer  file: '…/master.m3u8'
//
//  Every outbound request goes through the cookie jar below: cookies are read
//  off each response (both the parsed map and raw Set-Cookie), merged into
//  $store and replayed on the next request, exactly like the browser does.
//
// ─────────────────────────────────────────────────────────────────────────────

class Provider {
    private baseUrl          = "{{baseUrl}}"
    private preferredQuality = "{{preferred_quality}}"
    private fallbackBase     = "https://anidb.app"

    private cacheTtl        = 900_000    // 15 min — episode lists
    private langCacheTtl    = 300_000    // 5 min  — per-episode language lists
    private playCacheTtl    = 120_000    // 2 min  — playability probes
    private jarTtl          = 6_600_000  // 110 min — server sets Max-Age=7200 (2 h)
    private sessionProbeTtl = 300_000    // 5 min  — don't re-warm the session constantly

    private userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

    // ─── Base URL ─────────────────────────────────────────────────────────────

    private site(): string {
        const raw = this.baseUrl
        const usable = raw && raw.indexOf("{{") === -1 ? raw : this.fallbackBase
        return usable.replace(/\/+$/, "")
    }

    // ─── Cookie jar ───────────────────────────────────────────────────────────

    private jarKey(): string { return `anidb:jar:${this.site()}` }

    private loadJar(): Record<string, string> {
        const jar = this.readCache<Record<string, string>>(this.jarKey(), this.jarTtl)
        return jar ? jar : {}
    }

    private saveJar(jar: Record<string, string>): void {
        this.writeCache(this.jarKey(), jar)
    }

    private cookieHeader(): string {
        const jar   = this.loadJar()
        const parts: string[] = []
        for (const name in jar) {
            const value = jar[name]
            if (name && value) parts.push(`${name}=${value}`)
        }
        return parts.join("; ")
    }

    /** Merge every Set-Cookie of a response into the jar (empty value / Max-Age=0 deletes). */
    private absorbCookies(res: FetchResponse): void {
        const found: Record<string, string> = {}
        let any = false

        try {
            const parsed = res.cookies
            for (const name in parsed) {
                if (!name) continue
                found[name] = parsed[name]
                any = true
            }
        } catch (_e) {}

        try {
            const raw = res.rawHeaders
            for (const key in raw) {
                if (key.toLowerCase() !== "set-cookie") continue
                const lines = raw[key] || []
                for (const line of lines) {
                    const pair = line.split(";")[0] || ""
                    const eq   = pair.indexOf("=")
                    if (eq <= 0) continue
                    const name = pair.slice(0, eq).trim()
                    if (!name) continue
                    const dead = /max-age\s*=\s*0/i.test(line) || /expires\s*=\s*thu,\s*01[ -]jan[ -]1970/i.test(line)
                    found[name] = dead ? "" : pair.slice(eq + 1).trim()
                    any = true
                }
            }
        } catch (_e) {}

        if (!any) return

        const jar = this.loadJar()
        let changed = false
        for (const name in found) {
            const value = found[name]
            if (!value) {
                if (jar[name] !== undefined) { delete jar[name]; changed = true }
                continue
            }
            if (jar[name] !== value) { jar[name] = value; changed = true }
        }
        if (changed) this.saveJar(jar)
    }

    /** Laravel hands out `anidb_session` on any page hit; the JSON APIs expect it back. */
    private async ensureSession(): Promise<void> {
        const jar = this.loadJar()
        if (jar["anidb_session"]) return
        if (this.readCache<boolean>("anidb:sessprobe", this.sessionProbeTtl)) return
        this.writeCache("anidb:sessprobe", true)
        try {
            await this.request(`${this.site()}/home`, { kind: "nav", timeout: 10 })
        } catch (_e) {}
    }

    // ─── Fetch ────────────────────────────────────────────────────────────────

    private headersFor(kind: "nav" | "xhr", referer?: string): Record<string, string> {
        const h: Record<string, string> = {
            "User-Agent":       this.userAgent,
            "Accept-Language":  "en-US,en;q=0.9",
            "sec-ch-ua":        '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
        }

        if (kind === "xhr") {
            h["Accept"]           = "application/json, text/html, */*;q=0.8"
            h["X-Requested-With"] = "XMLHttpRequest"
            h["sec-fetch-dest"]   = "empty"
            h["sec-fetch-mode"]   = "cors"
            h["sec-fetch-site"]   = "same-origin"
        } else {
            h["Accept"]                    = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
            h["sec-fetch-dest"]            = "document"
            h["sec-fetch-mode"]            = "navigate"
            h["sec-fetch-site"]            = referer ? "same-origin" : "none"
            h["sec-fetch-user"]            = "?1"
            h["upgrade-insecure-requests"] = "1"
        }

        h["Referer"] = referer || `${this.site()}/home`

        // Laravel mirrors the XSRF cookie back as a header for XHR calls.
        const jar = this.loadJar()
        if (kind === "xhr" && jar["XSRF-TOKEN"]) h["X-XSRF-TOKEN"] = this.decodeCookieValue(jar["XSRF-TOKEN"])

        const cookie = this.cookieHeader()
        if (cookie) h["Cookie"] = cookie

        return h
    }

    private decodeCookieValue(v: string): string {
        try { return decodeURIComponent(v) } catch (_e) { return v }
    }

    private async request(url: string, opts: { kind: "nav" | "xhr"; referer?: string; timeout?: number; tries?: number }): Promise<FetchResponse> {
        const tries = opts.tries ?? 2
        let lastErr: unknown

        for (let i = 0; i < tries; i++) {
            try {
                const res = await fetch(url, {
                    headers: this.headersFor(opts.kind, opts.referer),
                    timeout: opts.timeout ?? 12,
                })
                this.absorbCookies(res)
                if (res.ok || res.status < 500 || i === tries - 1) return res
            } catch (e) {
                lastErr = e
                if (i === tries - 1) throw e
            }
        }
        throw lastErr
    }

    private async getText(url: string, opts: { kind: "nav" | "xhr"; referer?: string; timeout?: number }): Promise<string> {
        const res = await this.request(url, opts)
        if (!res.ok) throw new Error(`[anidb] HTTP ${res.status} for ${url}`)
        const body = res.text()
        if (body.toLowerCase().indexOf("just a moment") !== -1) throw new Error(`[anidb] Cloudflare challenge on ${url}`)
        return body
    }

    private async getJson<T>(url: string, referer: string, timeout = 12): Promise<T> {
        const text = await this.getText(url, { kind: "xhr", referer, timeout })
        if (text.trim().indexOf("<") === 0) throw new Error(`[anidb] API returned HTML (blocked) for ${url}`)
        try {
            return JSON.parse(text) as T
        } catch (_e) {
            throw new Error(`[anidb] malformed JSON from ${url}`)
        }
    }

    // ─── Settings ─────────────────────────────────────────────────────────────

    getSettings(): Settings {
        return {
            episodeServers: ["Auto", "Japanese", "English"],
            supportsDub: true,
        }
    }

    // ─── Search ───────────────────────────────────────────────────────────────

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        await this.ensureSession()

        const audio   = opts.dub ? "dub" : "sub"
        const queries = this.searchQueries(opts)
        const results: SearchResult[]       = []
        const seen: Record<string, boolean> = {}
        let anyOk = false

        for (const q of queries) {
            let hits: { slug: string; title: string }[] = []
            try {
                const html = await this.getText(`${this.site()}/search/suggestions?q=${encodeURIComponent(q)}`, {
                    kind: "xhr",
                    referer: `${this.site()}/home`,
                })
                anyOk = true
                hits  = this.parseSuggestions(html)
            } catch (_e) {}

            if (hits.length === 0) {
                try {
                    const html = await this.getText(`${this.site()}/browse?q=${encodeURIComponent(q)}`, {
                        kind: "nav",
                        referer: `${this.site()}/home`,
                    })
                    anyOk = true
                    hits  = this.parseBrowse(html)
                } catch (_e) {}
            }

            for (const hit of hits) {
                if (seen[hit.slug]) continue
                if (this.siteIdFromSlug(hit.slug) === "") continue
                seen[hit.slug] = true
                results.push({
                    id:       this.encodeId(hit.slug, audio, opts.media.id, opts.media.episodeCount ?? 0),
                    title:    hit.title,
                    url:      `${this.site()}/anime/${hit.slug}`,
                    // Every entry carries a jpn track and most carry eng; the real
                    // per-episode language list is only known at server resolution.
                    subOrDub: "both",
                })
            }
        }

        if (!anyOk) throw new Error(`[anidb] search failed for "${queries[0]}" — site unreachable`)
        return results
    }

    private searchQueries(opts: SearchOptions): string[] {
        return [opts.query, opts.media.romajiTitle, opts.media.englishTitle]
            .map((t) => (t || "").trim())
            .filter((q, i, arr) => q.length > 0 && arr.indexOf(q) === i)
    }

    /** `/search/suggestions` returns bare <a data-search-item> rows. */
    private parseSuggestions(html: string): { slug: string; title: string }[] {
        const out: { slug: string; title: string }[] = []
        const $ = LoadDoc(html)

        $("a[data-search-item]").each((_i, a) => {
            const slug = this.slugFromHref(a.attr("href") || "")
            if (!slug) return
            const title = (a.find("p").first().text() || a.find("img").first().attr("alt") || "").trim()
            out.push({ slug, title: title || slug.replace(/-/g, " ") })
        })

        return out
    }

    /** `/browse` renders full anime cards. */
    private parseBrowse(html: string): { slug: string; title: string }[] {
        const out: { slug: string; title: string }[] = []
        const $ = LoadDoc(html)

        let cards = $("a.anime-card")
        if (cards.length() === 0) cards = $(".anime-grid a")
        if (cards.length() === 0) cards = $('a[href*="/anime/"]')

        cards.each((_i, a) => {
            const slug = this.slugFromHref(a.attr("href") || "")
            if (!slug) return
            const title = (a.attr("title") || a.find("img").first().attr("alt") || a.find("p").first().text() || "").trim()
            out.push({ slug, title: title || slug.replace(/-/g, " ") })
        })

        return out
    }

    private slugFromHref(href: string): string {
        if (!href) return ""
        const m = href.match(/\/anime\/([^/?#"']+)/i)
        return m ? m[1] : ""
    }

    /** `death-note-1199` → `1199` (the site's numeric anime id). */
    private siteIdFromSlug(slug: string): string {
        const m = slug.match(/-(\d+)$/)
        return m ? m[1] : ""
    }

    // ─── Episodes ─────────────────────────────────────────────────────────────

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const meta   = this.decodeId(id)
        const slug   = meta.base
        const siteId = this.siteIdFromSlug(slug)
        if (!siteId) throw new Error(`[anidb] findEpisodes: no site id in "${slug}"`)

        const cacheKey = `anidb:eps:${siteId}:${meta.audio}:${meta.anilistId}`
        const cached   = this.readCache<EpisodeDetails[]>(cacheKey)
        if (cached && cached.length > 0) return cached

        await this.ensureSession()

        const pageUrl = `${this.site()}/anime/${slug}`
        // The anime page is what mints/refreshes the session the API checks.
        try { await this.getText(pageUrl, { kind: "nav", referer: `${this.site()}/home` }) } catch (_e) {}

        const body = await this.getJson<{ episodes?: SiteEpisode[] }>(
            `${this.site()}/api/frontend/anime/${siteId}/episodes`,
            pageUrl,
        )
        const rows = (body?.episodes || []).filter((e) => e && e.id > 0 && e.number >= 1)
        if (rows.length === 0) throw new Error(`[anidb] no episodes for ${slug}`)

        const offset = this.numberOffset(rows.map((e) => e.number), meta.epCount)

        const episodes: EpisodeDetails[] = []
        for (const row of rows) {
            const number = row.number - offset
            if (number < 1) continue
            episodes.push({
                id:     this.encodeId(`${row.id}~${siteId}~${slug}`, meta.audio, meta.anilistId, meta.epCount),
                number,
                url:    pageUrl,
                title:  row.filler ? `Episode ${number} (Filler)` : `Episode ${number}`,
            })
        }
        if (episodes.length === 0) throw new Error(`[anidb] episode numbering produced nothing for ${slug}`)

        episodes.sort((a, b) => a.number - b.number)
        this.writeCache(cacheKey, episodes)
        return episodes
    }

    /**
     * AniDB numbers sequel seasons across the whole franchise (Solo Leveling S2
     * is 13–25). Returns what the site adds to a season-relative number, and 0
     * whenever the list is gapped or already fits the AniList entry's own run.
     */
    private numberOffset(numbers: number[], anilistTotal: number): number {
        if (numbers.length === 0) return 0
        let min = numbers[0]
        let max = numbers[0]
        for (const n of numbers) {
            if (n < min) min = n
            if (n > max) max = n
        }
        if (min <= 1) return 0
        if (max - min + 1 !== numbers.length) return 0
        if (anilistTotal > 0 && max <= anilistTotal) return 0
        return min - 1
    }

    // ─── Servers ──────────────────────────────────────────────────────────────

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const meta = this.decodeId(episode.id)
        const ep   = this.splitEpisodeBase(meta.base)
        if (!ep.epId) throw new Error(`[anidb] malformed episode id "${episode.id}"`)

        const ctx: Ctx = { anilistId: meta.anilistId, episode: episode.number }
        const langs    = await this.fetchLanguages(ep)
        if (langs.length === 0) throw new Error(`[anidb] no languages for episode ${episode.number}`)

        const isAuto = !server || server === "Auto" || server === "default"

        if (!isAuto) {
            const picked = langs.find((l) => this.langLabel(l).toLowerCase() === server.toLowerCase()
                || (l.code || "").toLowerCase() === server.toLowerCase())
            if (!picked) throw new Error(`[anidb] server "${server}" not available for episode ${episode.number}`)
            return this.resolveLanguage(picked, ctx)
        }

        const candidates = this.matchingLanguages(langs, meta.audio === "dub")
        if (candidates.length === 0) {
            throw new Error(`[anidb] no ${meta.audio} track for episode ${episode.number}`)
        }

        const settled  = await Promise.allSettled<EpisodeServer>(candidates.map((l) => this.resolveLanguage(l, ctx)))
        const resolved = settled
            .filter((r): r is PromiseFulfilledResult<EpisodeServer> => r.status === "fulfilled")
            .map((r) => r.value)
        if (resolved.length === 0) throw new Error(`[anidb] no playable stream for episode ${episode.number}`)

        const playable = await Promise.allSettled(resolved.map((s) => this.isPlayable(s)))
        const winIdx   = playable.findIndex((r) => r.status === "fulfilled" && r.value)
        return winIdx !== -1 ? resolved[winIdx] : resolved[0]
    }

    private splitEpisodeBase(base: string): EpMeta {
        const parts = base.split("~")
        return { epId: parts[0] || "", siteId: parts[1] || "", slug: parts[2] || "" }
    }

    private async fetchLanguages(ep: EpMeta): Promise<Lang[]> {
        const cacheKey = `anidb:langs:${ep.epId}`
        const cached   = this.readCache<Lang[]>(cacheKey, this.langCacheTtl)
        if (cached && cached.length > 0) return cached

        await this.ensureSession()

        const pageUrl = ep.slug ? `${this.site()}/anime/${ep.slug}` : `${this.site()}/home`
        const body    = await this.getJson<{ languages?: Lang[] }>(
            `${this.site()}/api/frontend/episode/${ep.epId}/languages`,
            pageUrl,
        )
        const langs = (body?.languages || []).filter((l) => l && l.embed_url)
        if (langs.length > 0) this.writeCache(cacheKey, langs)
        return langs
    }

    // ─── Language selection ───────────────────────────────────────────────────

    private langLabel(l: Lang): string {
        const name = (l.name || "").trim()
        if (name) return name
        const code = (l.code || "").trim()
        if (!code) return "AniDB"
        if (code === "jpn" || code === "sub") return "Japanese"
        if (code === "eng" || code === "dub") return "English"
        return code.toUpperCase()
    }

    private langMatches(l: Lang, wanted: string[]): boolean {
        const code = (l.code || "").toLowerCase()
        const name = (l.name || "").toLowerCase()
        return wanted.some((w) => code === w || name === w)
    }

    private isDubLang(l: Lang): boolean {
        return this.langMatches(l, ["eng", "en", "english", "dub"])
    }

    private isSubLang(l: Lang): boolean {
        if (this.isDubLang(l)) return false
        return this.langMatches(l, ["jpn", "ja", "japanese", "sub"]) || (l.code || "") !== ""
    }

    /** Dub never falls back to Japanese; sub prefers jpn, then any non-eng track. */
    private matchingLanguages(langs: Lang[], dub: boolean): Lang[] {
        const preferred = dub ? ["eng", "en", "english", "dub"] : ["jpn", "ja", "japanese", "sub"]
        const ordered: Lang[] = []

        for (const w of preferred) {
            for (const l of langs) {
                if (this.langMatches(l, [w]) && ordered.indexOf(l) === -1) ordered.push(l)
            }
        }
        if (dub) return ordered

        for (const l of langs) {
            if (this.isSubLang(l) && ordered.indexOf(l) === -1) ordered.push(l)
        }
        return ordered
    }

    // ─── Source resolution ────────────────────────────────────────────────────

    private async resolveLanguage(lang: Lang, _ctx: Ctx): Promise<EpisodeServer> {
        const embed = lang.embed_url || ""
        if (!embed) throw new Error("[anidb] language row without embed_url")

        const embedHtml = await this.getText(embed, { kind: "nav", referer: `${this.site()}/`, timeout: 12 })
        const master    = this.extractHls(embedHtml)
        if (!master) throw new Error(`[anidb] no HLS master in embed ${embed}`)

        const headers = {
            "User-Agent": this.userAgent,
            "Referer":    `${this.site()}/`,
            "Origin":     this.site(),
        }

        let videoSources: VideoSource[] = []
        try {
            const manifest = await fetch(master, { headers, timeout: 8 })
            if (manifest.ok) videoSources = this.parseM3U8Qualities(manifest.text(), master)
        } catch (_e) {}

        if (videoSources.length === 0) {
            videoSources.push({ url: master, type: "m3u8", quality: "default", subtitles: [] })
        }

        return {
            server: this.langLabel(lang),
            headers,
            videoSources: this.applyQualityPreference(videoSources),
        }
    }

    private extractHls(html: string): string {
        const patterns = [
            /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
            /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
            /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i,
        ]
        for (const re of patterns) {
            const m = html.match(re)
            if (m && m[1]) return m[1].replace(/\\\//g, "/")
        }
        const bare = html.match(/https:\/\/hls\.[^"'\\\s]+\/master\.m3u8/i)
        return bare ? bare[0] : ""
    }

    private parseM3U8Qualities(manifest: string, masterUrl: string): VideoSource[] {
        const sources: VideoSource[] = []
        const lines   = manifest.split(/\r?\n/)
        const dirUrl  = masterUrl.substring(0, masterUrl.lastIndexOf("/"))

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim()
            if (!line.startsWith("#EXT-X-STREAM-INF")) continue

            const resMatch     = line.match(/RESOLUTION=\d+x(\d+)/i)
            const qualityLabel = resMatch ? `${resMatch[1]}p` : "Adaptive"

            let nextLine = ""
            while (i + 1 < lines.length) {
                i++
                nextLine = lines[i].trim()
                if (nextLine && !nextLine.startsWith("#")) break
            }
            if (!nextLine) continue

            let absolute = nextLine
            if (!nextLine.startsWith("http://") && !nextLine.startsWith("https://")) {
                absolute = nextLine.startsWith("/")
                    ? `${this.originOf(masterUrl)}${nextLine}`
                    : `${dirUrl}/${nextLine}`
            }
            sources.push({ url: absolute, type: "m3u8", quality: qualityLabel, subtitles: [] })
        }

        if (sources.length > 0) {
            sources.unshift({ url: masterUrl, type: "m3u8", quality: "Auto", subtitles: [] })
        }
        return sources
    }

    private applyQualityPreference(sources: VideoSource[]): VideoSource[] {
        const raw    = this.preferredQuality
        const target = raw && raw.indexOf("{{") === -1 ? raw : "Auto"
        if (target === "Auto") return sources

        const matched = sources.find((s) => s.quality === target)
        if (!matched) return sources
        return [matched, ...sources.filter((s) => s.quality !== target)]
    }

    private async isPlayable(server: EpisodeServer): Promise<boolean> {
        const src = server.videoSources[0]
        if (!src?.url) return false

        const cacheKey = `anidb:play:${src.url}`
        const cached   = this.readCache<boolean>(cacheKey, this.playCacheTtl)
        if (cached !== undefined) return cached

        try {
            const res    = await fetch(src.url, { headers: server.headers, timeout: 10 })
            const result = res.ok && res.text().indexOf("#EXTM3U") !== -1
            this.writeCache(cacheKey, result)
            return result
        } catch (_e) {
            this.writeCache(cacheKey, false)
            return false
        }
    }

    // ─── ID encoding ──────────────────────────────────────────────────────────

    private encodeId(base: string, audio: string, anilistId: number, epCount: number): string {
        let out = `${base}$${audio}`
        if (anilistId > 0) out += `$al${anilistId}`
        if (epCount > 0)   out += `$ec${epCount}`
        return out
    }

    private decodeId(id: string): { base: string; audio: string; anilistId: number; epCount: number } {
        const parts = id.split("$")
        const out   = { base: parts[0] || "", audio: "sub", anilistId: 0, epCount: 0 }

        for (let i = 1; i < parts.length; i++) {
            const p = parts[i]
            if (p === "sub" || p === "dub") { out.audio = p; continue }
            if (p.startsWith("al")) {
                const n = parseInt(p.slice(2), 10)
                if (!isNaN(n)) out.anilistId = n
                continue
            }
            if (p.startsWith("ec")) {
                const n = parseInt(p.slice(2), 10)
                if (!isNaN(n)) out.epCount = n
            }
        }
        return out
    }

    // ─── Cache ────────────────────────────────────────────────────────────────

    private now(): number { try { return Date.now() } catch (_e) { return 0 } }

    private readCache<T>(key: string, ttl?: number): T | undefined {
        const entry = $store.get<{ at: number; data: T }>(key)
        const t     = this.now()
        const max   = ttl ?? this.cacheTtl
        if (entry && t > 0 && entry.at > 0 && t - entry.at < max) return entry.data
        return undefined
    }

    private writeCache<T>(key: string, data: T): void {
        const t = this.now()
        if (t > 0) $store.set(key, { at: t, data })
    }

    // ─── URL utilities ────────────────────────────────────────────────────────

    private originOf(u: string): string {
        const m = u.match(/^(https?:\/\/[^/]+)/i)
        return m ? m[1] : this.site()
    }
}
