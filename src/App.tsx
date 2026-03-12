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
  view_count?: number;
  upload_date?: string;
  description?: string;
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

function formatViews(n?: number): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`;
  return `${n} views`;
}

function formatUploadDate(d?: string): string {
  if (!d || d.length !== 8) return '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
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
  const [sidebarWidth, setSidebarWidth] = useState(310);
  const [isResizing, setIsResizing] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(['controls', 'search', 'sounds', 'tts', 'queue', 'logs'])
  );

  // Video mute & volume
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(0.5);
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

  // Sound upload
  const uploadAudioRef = useRef<HTMLAudioElement>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [uploadPlaying, setUploadPlaying] = useState(false);
  const [uploadVolume, setUploadVolume] = useState(1);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const uploadInputRef = useRef<HTMLInputElement>(null);

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

  const handleVolume = (val: number) => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.volume = val;
    setVolume(val);
    if (val > 0 && vid.muted) { vid.muted = false; setMuted(false); }
    if (val === 0) { vid.muted = true; setMuted(true); }
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

  // ─── Sidebar resize ─────────────────────────────────────────────────────────

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizing(true);
  }, []);

  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    setSidebarWidth(window.innerWidth - e.clientX);
  }, []);

  const onResizePointerUp = useCallback(() => {
    setIsResizing(false);
  }, []);

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

  // ─── Sound download ─────────────────────────────────────────────────────────

  const handleDownloadSound = (sound: Sound) => {
    const link = document.createElement('a');
    link.href = `${BOT_API}/sounds/${encodeURIComponent(sound.filename)}`;
    link.download = sound.filename;
    link.click();
  };

  // ─── Sound upload ──────────────────────────────────────────────────────────

  const handleUploadFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Revoke previous URL
    if (uploadPreviewUrl) URL.revokeObjectURL(uploadPreviewUrl);
    const url = URL.createObjectURL(file);
    setUploadFile(file);
    setUploadPreviewUrl(url);
    setUploadVolume(1);
    setUploadPlaying(false);
  };

  const handleUploadPreviewToggle = () => {
    const audio = uploadAudioRef.current;
    if (!audio || !uploadPreviewUrl) return;
    if (uploadPlaying) {
      audio.pause();
      setUploadPlaying(false);
    } else {
      audio.volume = uploadVolume;
      audio.play().catch(() => {});
      setUploadPlaying(true);
    }
  };

  const handleUploadVolumeChange = (val: number) => {
    setUploadVolume(val);
    const audio = uploadAudioRef.current;
    // Browser audio.volume is capped at 1; above that is boost-only for the backend
    if (audio) audio.volume = Math.min(val, 1);
  };

  // Convert slider value (0–2) to dB for the backend
  const volumeToDb = (v: number): number => {
    if (v <= 0) return -60;
    return Math.round(20 * Math.log10(v) * 10) / 10;
  };

  const handleUploadSubmit = async () => {
    if (!uploadFile || !requireUser()) return;
    const name = uploadName.trim();
    if (!name) { addToast('Enter a sound name', 'warning'); return; }
    setUploadBusy(true);
    try {
      const boostDb = volumeToDb(uploadVolume);
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('name', name);
      formData.append('username', username);
      if (boostDb !== 0) formData.append('boost', boostDb.toString());
      await axios.post(`${BOT_API}/api/control/sounds/upload`, formData);
      addToast(`Uploaded: ${name}`, 'success');
      setUploadFile(null);
      if (uploadPreviewUrl) URL.revokeObjectURL(uploadPreviewUrl);
      setUploadPreviewUrl(null);
      setUploadPlaying(false);
      setUploadVolume(1);
      setUploadName('');
      if (uploadInputRef.current) uploadInputRef.current.value = '';
      loadSounds();
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'Could not upload sound';
      addToast(msg, 'warning');
    } finally {
      setUploadBusy(false);
    }
  };

  const handleUploadCancel = () => {
    setUploadFile(null);
    if (uploadPreviewUrl) URL.revokeObjectURL(uploadPreviewUrl);
    setUploadPreviewUrl(null);
    setUploadPlaying(false);
    setUploadVolume(1);
    setUploadName('');
    if (uploadInputRef.current) uploadInputRef.current.value = '';
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
                onEnded={() => {
                  syncRef.current = { started: 0, needSeek: false, needFinalSync: false };
                  setVideoSrc('');
                  setIsPlaying(false);
                  setIsPaused(false);
                  setCurrentTitle('');
                  setCurrentTime(0);
                  setDuration(0);
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
        <aside
          className={`sidebar${sidebarOpen ? ' open' : ''}${isResizing ? ' resizing' : ''}`}
          style={sidebarOpen ? { width: sidebarWidth } : undefined}
        >
          {/* Resize handle */}
          <div
            className="sidebar-resize-handle"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
          />
          {/* First-time username overlay */}
          {!username && (
            <div className="username-overlay">
              <div className="username-overlay-card">
                <div className="username-overlay-icon">🎮</div>
                <h2 className="username-overlay-title">Welcome to Juky</h2>
                <p className="username-overlay-sub">Enter your name to get started</p>
                <input
                  ref={nameInputRef}
                  className="username-overlay-input"
                  type="text"
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && confirmName()}
                  placeholder="Your name…"
                  maxLength={32}
                  autoFocus
                />
                <button className="username-overlay-btn" onClick={confirmName} disabled={!nameInput.trim()}>
                  Continue
                </button>
              </div>
            </div>
          )}

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
              <div className="volume-row">
                <label className="volume-label">Volume</label>
                <input
                  className="volume-slider"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={muted ? 0 : volume}
                  onChange={e => handleVolume(parseFloat(e.target.value))}
                />
                <span className="volume-pct">{muted ? 0 : Math.round(volume * 100)}%</span>
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
                  <div className="search-result-card" key={r.id}>
                    <div className="result-thumb-wrap">
                      <img className="result-thumb" src={r.thumbnail} alt="" loading="lazy" />
                      {r.duration && <span className="result-duration">{r.duration}</span>}
                    </div>
                    <div className="result-details">
                      <div className="result-title">{r.title}</div>
                      <div className="result-channel">{r.uploader}</div>
                      <div className="result-meta">
                        {formatViews(r.view_count)}
                        {r.view_count && r.upload_date ? ' · ' : ''}
                        {formatUploadDate(r.upload_date)}
                      </div>
                      {r.description && (
                        <div className="result-desc">{r.description.slice(0, 100)}{r.description.length > 100 ? '…' : ''}</div>
                      )}
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
                      <button className="icon-btn" onClick={() => handleDownloadSound(s)} title="Download">⬇</button>
                      <button className="icon-btn send" onClick={() => handlePlaySound(s.name)} title="Play in Discord">🎵</button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Upload */}
              <div className="upload-panel">
                <div className="upload-header">Upload Sound</div>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept="audio/*"
                  onChange={handleUploadFileSelect}
                  className="upload-file-input"
                  id="sound-upload-input"
                />
                {!uploadFile && (
                  <label htmlFor="sound-upload-input" className="upload-drop-label">
                    Choose an audio file…
                  </label>
                )}
                {uploadFile && uploadPreviewUrl && (
                  <div className="upload-preview">
                    <audio
                      ref={uploadAudioRef}
                      src={uploadPreviewUrl}
                      onEnded={() => setUploadPlaying(false)}
                    />
                    <div className="upload-file-info">
                      <span className="upload-file-name">{uploadFile.name}</span>
                      <button className="icon-btn" onClick={handleUploadCancel} title="Remove">✕</button>
                    </div>
                    <input
                      className="upload-name-input"
                      type="text"
                      placeholder="Sound name…"
                      value={uploadName}
                      onChange={e => setUploadName(e.target.value)}
                      maxLength={64}
                    />
                    <div className="upload-controls">
                      <button
                        className={`icon-btn${uploadPlaying ? ' active' : ''}`}
                        onClick={handleUploadPreviewToggle}
                        title="Preview"
                      >
                        {uploadPlaying ? '⏸' : '▶'}
                      </button>
                      <input
                        className="volume-slider upload-volume-slider"
                        type="range"
                        min="0"
                        max="2"
                        step="0.01"
                        value={uploadVolume}
                        onChange={e => handleUploadVolumeChange(parseFloat(e.target.value))}
                      />
                      <span className="upload-boost-label">
                        {(() => {
                          const db = volumeToDb(uploadVolume);
                          if (db === 0) return '0 dB';
                          return `${db > 0 ? '+' : ''}${db} dB`;
                        })()}
                      </span>
                    </div>
                    <div className="upload-boost-hint">
                      Adjust volume to preview boost — sent as dB to Discord
                    </div>
                    <button
                      className="btn-primary"
                      onClick={handleUploadSubmit}
                      disabled={uploadBusy || !uploadName.trim()}
                    >
                      {uploadBusy ? 'Uploading…' : '⬆ Upload Sound'}
                    </button>
                  </div>
                )}
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
