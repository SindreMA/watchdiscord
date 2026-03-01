import React, { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import * as signalR from '@microsoft/signalr';
import axios from 'axios';

// ─── Types ────────────────────────────────────────────────────────────────────

interface QueueItem {
  friendlyName: string;
  value: string;
  started: number;
  type: 'play' | 'pause' | 'resume' | 'stop';
  guildId: string;
  fileType: string;
  youtubeUrl?: string;
  videoId?: string;
  streamUrl?: string;
}

interface ActionLog {
  timestamp: number;
  guildId: string;
  username: string;
  action: string;
  details?: string;
}

interface SearchResult {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  uploader: string;
  url: string;
}

interface Sound {
  name: string;
  filename: string;
}

interface QueueEntry {
  friendlyName: string;
  youtubeUrl?: string | null;
  videoId?: string | null;
  isPlaying: boolean;
}

interface Toast {
  id: number;
  message: string;
  type: 'info' | 'success' | 'warning';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BOT_API = '/botapi';
const SIGNALR_URL = 'https://api.sindrema.com/JukyHub';
const WATCH_API = 'https://api.sindrema.com/api/Juky/watch';

let toastCounter = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function decodeTitle(name: string): string {
  try { return decodeURIComponent(name); } catch { return name; }
}

function formatDuration(secs: number): string {
  if (!secs || !isFinite(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── SidebarSection ──────────────────────────────────────────────────────────

interface SectionProps {
  id: string;
  title: string;
  active: boolean;
  onToggle: (id: string) => void;
  onOpen?: () => void;
  badge?: number | string;
  children: React.ReactNode;
}

function SidebarSection({ id, title, active, onToggle, onOpen, badge, children }: SectionProps) {
  const handleClick = () => {
    if (!active && onOpen) onOpen();
    onToggle(id);
  };
  return (
    <div className={`section${active ? ' active' : ''}`}>
      <button className="section-header" onClick={handleClick}>
        <span className="section-chevron">{active ? '▾' : '▸'}</span>
        <span className="section-title">{title}</span>
        {badge !== undefined && <span className="section-badge">{badge}</span>}
      </button>
      {active && <div className="section-body">{children}</div>}
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const guildId = window.location.pathname.split('/').filter(Boolean).pop() || '';

  // Username
  const [username, setUsername] = useState(localStorage.getItem('juky_username') || '');
  const [nameInput, setNameInput] = useState(localStorage.getItem('juky_username') || '');
  const [editingName, setEditingName] = useState(!localStorage.getItem('juky_username'));
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Video
  const videoRef = useRef<HTMLVideoElement>(null);
  // Sync state: set when a new play event starts; cleared once playback is confirmed in-sync
  const syncRef = useRef<{ started: number; needSeek: boolean; needFinalSync: boolean }>({
    started: 0, needSeek: false, needFinalSync: false,
  });
  const [videoSrc, setVideoSrc] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentTitle, setCurrentTitle] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(['controls', 'search', 'sounds', 'tts', 'queue', 'logs'])
  );

  // Video mute
  const [muted, setMuted] = useState(true);
  const [clickIcon, setClickIcon] = useState<'play' | 'pause' | null>(null);
  const clickIconTimeout = useRef<ReturnType<typeof setTimeout>>();

  // Sync offset — positive = seek further ahead (compensate for video being behind Discord)
  // Default comes from build-time env: REACT_APP_VIDEO_OFFSET_S=2
  const [offsetS, setOffsetS] = useState(() =>
    parseFloat((process.env.REACT_APP_VIDEO_OFFSET_S as string) || '0')
  );

  // TTS voice
  const [ttsVoice, setTtsVoice] = useState('Salli');

  // Data
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [soundFilter, setSoundFilter] = useState('');
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [logs, setLogs] = useState<ActionLog[]>([]);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // TTS
  const [ttsText, setTtsText] = useState('');
  const [ttsBusy, setTtsBusy] = useState(false);

  // Sound preview
  const previewAudioRef = useRef<HTMLAudioElement>(null);
  const [previewingSound, setPreviewingSound] = useState<string | null>(null);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = ++toastCounter;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4200);
  }, []);

  // ─── API helpers ─────────────────────────────────────────────────────────────

  const get = useCallback((path: string) =>
    axios.get(`${BOT_API}${path}`), []);

  const post = useCallback((path: string, data: any) =>
    axios.post(`${BOT_API}${path}`, data), []);

  // ─── Data loaders ─────────────────────────────────────────────────────────────

  const loadSounds = useCallback(async () => {
    try {
      const res = await get(`/api/control/${guildId}/sounds`);
      const raw: (Sound | string)[] = res.data.sounds || [];
      setSounds(raw.map((s: any) =>
        typeof s === 'string' ? { name: s, filename: s + '.wav' } : s
      ));
    } catch {}
  }, [guildId, get]);

  const loadLogs = useCallback(async () => {
    try {
      const res = await get(`/api/control/logs`);
      const filtered: ActionLog[] = (res.data.logs || []).filter((l: ActionLog) => l.guildId === guildId);
      setLogs(filtered);
    } catch {}
  }, [guildId, get]);

  const loadQueue = useCallback(async () => {
    try {
      const res = await get(`/api/control/${guildId}/queue`);
      setQueue(res.data.queue || []);
    } catch {}
  }, [guildId, get]);

  // ─── Video sync ──────────────────────────────────────────────────────────────

  const handlePlayEvent = useCallback((item: QueueItem) => {
    const src = item.streamUrl ||
      `https://stream.sindrema.com/${encodeURIComponent(item.friendlyName)}${item.fileType}`;
    // Mark that we need to seek once the video can play; seek time is calculated
    // at that moment so it accounts for all network/buffering delay.
    syncRef.current = { started: item.started, needSeek: true, needFinalSync: false };
    setVideoSrc(src);
    setCurrentTitle(decodeTitle(item.friendlyName));
    setIsPlaying(true);
    setIsPaused(false);
  }, []);

  // ─── SignalR + init ───────────────────────────────────────────────────────────

  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current || !guildId) return;
    mounted.current = true;

    // Load initial events to restore state on page load
    axios.get<QueueItem[]>(`${WATCH_API}/${guildId}`).then(res => {
      const events = res.data || [];
      if (!events.length) return;

      const last = events[events.length - 1];
      if (last.type === 'stop') return;

      // Find the last play event for video source/title info
      const lastPlay = [...events].reverse().find(e => e.type === 'play');
      if (!lastPlay) return;

      const src = lastPlay.streamUrl ||
        `https://stream.sindrema.com/${encodeURIComponent(lastPlay.friendlyName)}${lastPlay.fileType}`;

      if (last.type === 'pause') {
        setVideoSrc(src);
        setCurrentTitle(decodeTitle(lastPlay.friendlyName));
        setIsPlaying(true);
        setIsPaused(true);
        // Approximate paused position: time elapsed between play start and pause event
        setTimeout(() => {
          const vid = videoRef.current;
          if (vid) {
            vid.currentTime = Math.max(0, (last.started - lastPlay.started) / 1000);
          }
        }, 200);
      } else {
        // play or resume — video is currently running
        // For resume events, we approximate by using the last play's started time.
        // This may drift if there were pauses, but at least shows the video playing.
        handlePlayEvent(lastPlay);
      }
    }).catch(() => {});

    loadSounds();

    // SignalR real-time events
    const connection = new signalR.HubConnectionBuilder()
      .withUrl(SIGNALR_URL)
      .configureLogging(signalR.LogLevel.Warning)
      .withAutomaticReconnect()
      .build();

    connection.on('eventadded', (data: QueueItem) => {
      if (data.guildId !== guildId) return;

      if (data.type === 'play') {
        handlePlayEvent(data);
        addToast(`▶  Now playing: ${decodeTitle(data.friendlyName)}`, 'info');
        loadLogs();
        loadQueue();
      } else if (data.type === 'pause') {
        videoRef.current?.pause();
        setIsPaused(true);
        addToast('⏸  Playback paused', 'info');
        loadLogs();
      } else if (data.type === 'resume') {
        videoRef.current?.play().catch(() => {});
        setIsPaused(false);
        addToast('▶  Playback resumed', 'info');
        loadLogs();
      } else if (data.type === 'stop') {
        syncRef.current = { started: 0, needSeek: false, needFinalSync: false };
        const vid = videoRef.current;
        if (vid) { vid.pause(); vid.src = ''; }
        setVideoSrc('');
        setIsPlaying(false);
        setIsPaused(false);
        setCurrentTitle('');
        setQueue([]);
        addToast('⏹  Playback stopped', 'warning');
        loadLogs();
      }
    });

    connection.start().catch(() => {});
  }, [guildId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Controls ─────────────────────────────────────────────────────────────────

  const requireUser = () => {
    if (!username) {
      setSidebarOpen(true);
      setEditingName(true);
      setTimeout(() => nameInputRef.current?.focus(), 50);
      addToast('Set your name first', 'warning');
      return false;
    }
    return true;
  };

  const handlePause = async () => {
    if (!requireUser()) return;
    try { await post(`/api/control/${guildId}/pause`, { username }); }
    catch { addToast('Could not pause', 'warning'); }
  };

  const handleResume = async () => {
    if (!requireUser()) return;
    try { await post(`/api/control/${guildId}/resume`, { username }); }
    catch { addToast('Could not resume', 'warning'); }
  };

  const handleStop = async () => {
    if (!requireUser()) return;
    try { await post(`/api/control/${guildId}/stop`, { username }); }
    catch { addToast('Could not stop', 'warning'); }
  };

  const handleSkip = async () => {
    if (!requireUser()) return;
    try { await post(`/api/control/${guildId}/skip`, { username }); }
    catch { addToast('Could not skip', 'warning'); }
  };

  const handleVideoClick = () => {
    const vid = videoRef.current;
    if (!vid) return;
    clearTimeout(clickIconTimeout.current);
    if (vid.paused) {
      vid.play().catch(() => {});
      setClickIcon('play');
    } else {
      vid.pause();
      setClickIcon('pause');
    }
    clickIconTimeout.current = setTimeout(() => setClickIcon(null), 700);
  };

  const toggleMute = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const next = !vid.muted;
    vid.muted = next;
    setMuted(next);
  };

  const progressRef = useRef<HTMLDivElement>(null);

  const seekToRatio = useCallback((clientX: number) => {
    const vid = videoRef.current;
    const el = progressRef.current;
    if (!vid || !el || !duration) return;
    const rect = el.getBoundingClientRect();
    vid.currentTime = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  }, [duration]);

  const onProgressPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekToRatio(e.clientX);
  };
  const onProgressPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 1) seekToRatio(e.clientX);
  };

  // ─── YouTube search ───────────────────────────────────────────────────────────

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchResults([]);
    try {
      const res = await get(`/api/control/search?q=${encodeURIComponent(searchQuery)}`);
      setSearchResults(res.data.results || []);
    } catch {
      addToast('Search failed', 'warning');
    } finally {
      setSearchLoading(false);
    }
  };

  const handleQueue = async (url: string, title: string) => {
    if (!requireUser()) return;
    try {
      await post(`/api/control/${guildId}/play`, { url, username });
      addToast(`+ Queued: ${title}`, 'success');
    } catch {
      addToast('Could not queue video', 'warning');
    }
  };

  // ─── Sounds ──────────────────────────────────────────────────────────────────

  const handlePlaySound = async (name: string) => {
    if (!requireUser()) return;
    try {
      await post(`/api/control/${guildId}/sound`, { sound: name, username });
      addToast(`🔊 ${name}`, 'success');
    } catch {
      addToast('Could not play sound', 'warning');
    }
  };

  const handlePreview = (sound: Sound) => {
    if (previewingSound === sound.name) {
      previewAudioRef.current?.pause();
      setPreviewingSound(null);
      return;
    }
    const audio = previewAudioRef.current;
    if (!audio) return;
    audio.src = `${BOT_API}/sounds/${encodeURIComponent(sound.filename)}`;
    audio.play().catch(() => {
      // Try alternative extension
      const alt = sound.filename.replace(/\.(wav|mp3)$/i, (_, ext) =>
        ext.toLowerCase() === 'wav' ? '.mp3' : '.wav'
      );
      audio.src = `${BOT_API}/sounds/${encodeURIComponent(alt)}`;
      audio.play().catch(() => {});
    });
    setPreviewingSound(sound.name);
  };

  // ─── TTS ─────────────────────────────────────────────────────────────────────

  const handleTTS = async () => {
    if (!requireUser() || !ttsText.trim()) return;
    setTtsBusy(true);
    try {
      await post(`/api/control/${guildId}/tts`, { text: ttsText, voice: ttsVoice, username });
      addToast('📢 TTS sent!', 'success');
      setTtsText('');
    } catch {
      addToast('Could not send TTS', 'warning');
    } finally {
      setTtsBusy(false);
    }
  };

  // ─── Username ─────────────────────────────────────────────────────────────────

  const confirmName = () => {
    const name = nameInput.trim();
    if (!name) return;
    localStorage.setItem('juky_username', name);
    setUsername(name);
    setEditingName(false);
  };

  // ─── Section toggle ───────────────────────────────────────────────────────────

  const toggleSection = (id: string) =>
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const filteredSounds = soundFilter
    ? sounds.filter(s => s.name.toLowerCase().includes(soundFilter.toLowerCase()))
    : sounds;

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="app">

      <div className="layout">

        {/* Video */}
        <div className="video-area">
          {videoSrc
            ? <video
                ref={videoRef}
                src={videoSrc}
                className="video"
                playsInline
                muted={muted}
                onTimeUpdate={(e: React.SyntheticEvent<HTMLVideoElement>) => setCurrentTime(e.currentTarget.currentTime)}
                onDurationChange={(e: React.SyntheticEvent<HTMLVideoElement>) => setDuration(e.currentTarget.duration)}
                onCanPlay={(e: React.SyntheticEvent<HTMLVideoElement>) => {
                  if (!syncRef.current.needSeek) return;
                  syncRef.current.needSeek = false;
                  syncRef.current.needFinalSync = true;
                  const vid = e.currentTarget;
                  vid.currentTime = Math.max(0, (Date.now() - syncRef.current.started) / 1000 + offsetS);
                  vid.play().catch(() => {});
                }}
                onPlaying={(e: React.SyntheticEvent<HTMLVideoElement>) => {
                  if (!syncRef.current.needFinalSync) return;
                  syncRef.current.needFinalSync = false;
                  const vid = e.currentTarget;
                  const expected = Math.max(0, (Date.now() - syncRef.current.started) / 1000 + offsetS);
                  if (Math.abs(vid.currentTime - expected) > 0.3) {
                    vid.currentTime = expected;
                  }
                }}
                onClick={handleVideoClick}
              />
            : (
              <div className="video-empty">
                <div className="video-empty-icon">🎵</div>
                <div className="video-empty-text">Nothing playing</div>
                <div className="video-empty-sub">Play something in Discord to start watching</div>
              </div>
            )
          }

          {clickIcon && (
            <div key={clickIcon} className="click-indicator">
              {clickIcon === 'pause' ? '⏸' : '▶'}
            </div>
          )}

          {currentTitle && (
            <div className="video-info">
              <div className="video-info-row">
                <span className="video-title">{currentTitle}</span>
                {duration > 0 && (
                  <span className="video-time">
                    {formatDuration(currentTime)} / {formatDuration(duration)}
                  </span>
                )}
              </div>
              <div
                ref={progressRef}
                className="progress-wrap"
                onPointerDown={onProgressPointerDown}
                onPointerMove={onProgressPointerMove}
              >
                <div
                  className="progress-fill"
                  style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          <button
            className={`mute-btn${muted ? ' muted' : ''}`}
            onClick={toggleMute}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? '🔇' : '🔊'}
          </button>

          <button
            className="sidebar-toggle-btn"
            onClick={() => setSidebarOpen(s => !s)}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            {sidebarOpen ? '›' : '‹'}
          </button>
        </div>

        {/* Sidebar */}
        <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
          <div className="sidebar-head">
            <div className="sidebar-brand">
              <span className="brand-icon">🎮</span>
              <span className="brand-name">Juky</span>
            </div>
            {editingName ? (
              <div className="name-form">
                <input
                  ref={nameInputRef}
                  className="name-input"
                  type="text"
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && confirmName()}
                  onBlur={() => { if (username) setEditingName(false); }}
                  placeholder="Your name…"
                  maxLength={32}
                  autoFocus
                />
                <button className="name-save-btn" onClick={confirmName} title="Save">✓</button>
              </div>
            ) : (
              <button className="username-btn" onClick={() => { setNameInput(username); setEditingName(true); }}>
                {username} <span className="edit-icon">✎</span>
              </button>
            )}
          </div>

          <div className="sidebar-content">

            {/* Controls */}
            <SidebarSection id="controls" title="Controls" active={openSections.has('controls')} onToggle={toggleSection}>
              <div className="controls-row">
                {isPaused
                  ? <button className="ctrl-btn resume" onClick={handleResume}>▶ Resume</button>
                  : <button className="ctrl-btn pause" onClick={handlePause} disabled={!isPlaying}>⏸ Pause</button>
                }
                <button className="ctrl-btn skip" onClick={handleSkip} disabled={!isPlaying}>⏭ Skip</button>
                <button className="ctrl-btn stop" onClick={handleStop} disabled={!isPlaying}>⏹ Stop</button>
              </div>
              <div className={`playback-status${isPlaying ? (isPaused ? ' paused' : ' playing') : ''}`}>
                <span className="status-dot" />
                {isPlaying ? (isPaused ? 'Paused' : 'Playing') : 'Idle'}
              </div>
              <div className="offset-row">
                <label className="offset-label" htmlFor="offset-input">Sync offset</label>
                <input
                  id="offset-input"
                  className="offset-input"
                  type="number"
                  step="0.5"
                  value={offsetS}
                  onChange={e => setOffsetS(parseFloat(e.target.value) || 0)}
                />
                <span className="offset-unit">s</span>
              </div>
            </SidebarSection>

            {/* YouTube Search */}
            <SidebarSection id="search" title="YouTube Search" active={openSections.has('search')} onToggle={toggleSection}>
              <div className="search-input-row">
                <input
                  className="search-input"
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  placeholder="Search for videos…"
                />
                <button className="search-btn" onClick={handleSearch} disabled={searchLoading}>
                  {searchLoading ? '…' : '🔍'}
                </button>
              </div>
              <div className="search-results">
                {searchLoading && <div className="loading-row">Searching…</div>}
                {searchResults.map(r => (
                  <div className="search-result" key={r.id}>
                    <img className="result-thumb" src={r.thumbnail} alt="" loading="lazy" />
                    <div className="result-info">
                      <div className="result-title">{r.title}</div>
                      <div className="result-meta">{r.uploader}{r.duration ? ` · ${r.duration}` : ''}</div>
                    </div>
                    <button className="result-add" onClick={() => handleQueue(r.url, r.title)} title="Add to queue">+</button>
                  </div>
                ))}
              </div>
            </SidebarSection>

            {/* Sounds */}
            <SidebarSection id="sounds" title="Sounds" active={openSections.has('sounds')} onToggle={toggleSection} badge={sounds.length} onOpen={loadSounds}>
              <audio ref={previewAudioRef} onEnded={() => setPreviewingSound(null)} />
              {sounds.length > 6 && (
                <input
                  className="sounds-search"
                  type="text"
                  placeholder="Filter sounds…"
                  value={soundFilter}
                  onChange={e => setSoundFilter(e.target.value)}
                />
              )}
              <div className="sounds-list">
                {filteredSounds.length === 0 && <div className="empty-msg">No sounds found</div>}
                {filteredSounds.map(s => (
                  <div className="sound-row" key={s.name}>
                    <span className="sound-name">{s.name}</span>
                    <div className="sound-actions">
                      <button
                        className={`icon-btn${previewingSound === s.name ? ' active' : ''}`}
                        onClick={() => handlePreview(s)}
                        title="Preview in browser"
                      >
                        {previewingSound === s.name ? '⏸' : '▶'}
                      </button>
                      <button className="icon-btn send" onClick={() => handlePlaySound(s.name)} title="Play in Discord">🎵</button>
                    </div>
                  </div>
                ))}
              </div>
            </SidebarSection>

            {/* TTS */}
            <SidebarSection id="tts" title="Text to Speech" active={openSections.has('tts')} onToggle={toggleSection}>
              <div className="tts-panel">
                <select
                  className="tts-voice-select"
                  value={ttsVoice}
                  onChange={e => setTtsVoice(e.target.value)}
                >
                  <option value="Salli">Salli (EN-F)</option>
                  <option value="Joanna">Joanna (EN-F)</option>
                  <option value="Joey">Joey (EN-M)</option>
                  <option value="Matthew">Matthew (EN-M)</option>
                  <option value="Maxim">Maxim (RU-M)</option>
                  <option value="Hans">Hans (DE-M)</option>
                </select>
                <textarea
                  className="tts-input"
                  value={ttsText}
                  onChange={e => setTtsText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleTTS())}
                  placeholder="Type something for the bot to say… (Enter to send)"
                  rows={3}
                />
                <button className="btn-primary" onClick={handleTTS} disabled={ttsBusy || !ttsText.trim()}>
                  {ttsBusy ? 'Sending…' : '📢 Send TTS'}
                </button>
              </div>
            </SidebarSection>

            {/* Queue */}
            <SidebarSection id="queue" title="Queue" active={openSections.has('queue')} onToggle={toggleSection} badge={queue.length} onOpen={loadQueue}>
              <div className="queue-list">
                {queue.length === 0 && <div className="empty-msg">Queue is empty</div>}
                {queue.map((item, i) => (
                  <div className={`queue-item${item.isPlaying ? ' now-playing' : ''}`} key={i}>
                    <span className="queue-pos">{item.isPlaying ? '▶' : i}</span>
                    <span className="queue-name">{decodeTitle(item.friendlyName)}</span>
                    {item.youtubeUrl && (
                      <a className="queue-yt" href={item.youtubeUrl} target="_blank" rel="noreferrer">↗</a>
                    )}
                  </div>
                ))}
              </div>
            </SidebarSection>

            {/* Activity */}
            <SidebarSection id="logs" title="Activity" active={openSections.has('logs')} onToggle={toggleSection} onOpen={loadLogs}>
              <div className="logs-list">
                {logs.length === 0 && <div className="empty-msg">No activity yet</div>}
                {logs.slice(0, 40).map((log, i) => (
                  <div className="log-row" key={i}>
                    <span className="log-user">{log.username}</span>
                    <span className={`log-action action-${log.action}`}>{log.action}</span>
                    {log.details && (
                      <span className="log-details" title={log.details}>
                        {log.details.length > 22 ? log.details.slice(0, 22) + '…' : log.details}
                      </span>
                    )}
                    <span className="log-time">{formatTime(log.timestamp)}</span>
                  </div>
                ))}
              </div>
            </SidebarSection>

          </div>
        </aside>

      </div>

      {/* Toast notifications */}
      <div className="toasts">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.message}</div>
        ))}
      </div>

    </div>
  );
}
