import React, { useState, useEffect, useMemo } from 'react';
import { 
  Sparkles, 
  Check, 
  X, 
  Plus, 
  Cloud, 
  RefreshCw, 
  Bookmark, 
  Trash2, 
  Sliders, 
  BookOpen, 
  Zap, 
  Search, 
  Layers,
  Award
} from 'lucide-react';
import { 
  Radar, 
  RadarChart, 
  PolarGrid, 
  PolarAngleAxis, 
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  Tooltip
} from 'recharts';
import { supabase, pushToCloud } from './cloudsync';

// --- Global Core Configurations ---
const DEFAULT_GEMINI_KEY = "";
const HARVEST_URL = "https://raw.githubusercontent.com/lioned97/spinstack-harvest/main/papers/latest.json";
const DEFAULT_SETTINGS = {
  harvestUrl: HARVEST_URL,
  geminiApiKey: "",
  theme: "dark"
};

// --- Local Storage Shell Helpers ---
const sGet = (key) => {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    console.error("Storage read exception:", e);
    return null;
  }
};

const persist = (key, val) => {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    console.error("Storage write exception:", e);
  }
};

export default function SpinStack() {
  // --- Screen Context States ---
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= 1024);
  
  // --- Core Application States ---
  const [stack, setStack] = useState(() => sGet('ss_papers_pool') || []);
  const [currentIndex, setCurrentIndex] = useState(() => sGet('ss_current_index') || 0);
  const [savedPapers, setSavedPapers] = useState(() => sGet('ss_saved_stack') || []);
  const [topics, setTopics] = useState(() => sGet('ss_tracked_topics') || [
    { id: '1', name: 'NV-Centers', count: 45 },
    { id: '2', name: 'Open Quantum Systems', count: 32 },
    { id: '3', name: 'Spin Decoherence', count: 34 }
  ]);
  const [settings, setSettings] = useState(() => {
    const stored = sGet('ss_settings');
    return stored ? { ...DEFAULT_SETTINGS, ...stored } : DEFAULT_SETTINGS;
  });
  
  // --- UI Interactivity States ---
  const [newTopicInput, setNewTopicInput] = useState("");
  const [aiAnalysis, setAiAnalysis] = useState("");
  const [analyzingId, setAnalyzingId] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [userEmail, setUserEmail] = useState(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [activeTab, setActiveTab] = useState('stack'); // 'stack' or 'saved'

  // --- Dynamic Screen Metric Listener ---
  useEffect(() => {
    const handleResize = () => setIsDesktop(window.innerWidth >= 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // --- Detect Active Supabase User Session ---
  useEffect(() => {
    const checkUser = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        setUserEmail(session.user.email);
      }
    };
    checkUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUserEmail(session.user.email);
      } else {
        setUserEmail(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // --- Fallback Mechanism: Populate Stack from Harvest Feed if Dry ---
  useEffect(() => {
    if (stack.length === 0) {
      triggerFeedHarvest();
    }
  }, []);

  // --- Keep State Tracking Synchronized Across Operations ---
  useEffect(() => {
    persist('ss_current_index', currentIndex);
  }, [currentIndex]);

  useEffect(() => {
    persist('ss_settings', settings);
    persist('ss_theme', settings.theme);
  }, [settings]);

  const currentPaper = useMemo(() => {
    if (currentIndex >= stack.length) return null;
    return stack[currentIndex];
  }, [stack, currentIndex]);

  const isAcceptableYear = (year) => {
    const currentYear = new Date().getFullYear();
    const numeric = parseInt(year, 10);
    return numeric >= 2000 && numeric <= currentYear + 1;
  };

  const qualityFilter = (paper) => {
    if (!paper || !paper.id || !paper.title) return false;
    if (!isAcceptableYear(paper.year)) return false;
    const lowerSource = `${paper.venue || ''}`.toLowerCase();
    const lowerUrl = `${paper.url || ''}`.toLowerCase();
    const rejectSources = ['zenodo', 'ssrn', 'cairn', 'researchgate', 'biorxiv', 'medrxiv'];
    if (rejectSources.some(tag => lowerSource.includes(tag) || lowerUrl.includes(tag))) {
      return lowerUrl.includes('arxiv.org') || lowerSource.includes('arxiv');
    }
    return true;
  };

  // OpenAlex ships abstracts as an inverted index ({word: [positions]}) — rebuild the text.
  const reconstructAbstract = (inverted) => {
    try {
      const words = [];
      Object.entries(inverted).forEach(([word, positions]) => {
        positions.forEach((pos) => { words[pos] = word; });
      });
      return words.join(' ').trim();
    } catch (_) {
      return '';
    }
  };

  const normalizePaper = (record) => {
    if (!record) return null;
    const title = record.title || record.display_name || '';
    const abstract = record.abstract
      || (record.abstract_inverted_index ? reconstructAbstract(record.abstract_inverted_index) : '')
      || 'Abstract unavailable.';
    const authors = record.authors || record.authorships?.map(a => a.author.display_name) || ['Unknown author'];
    const year = record.year || record.publication_year || (record.published ? new Date(record.published).getFullYear() : undefined);
    const venue = record.venue || record.primary_location?.source?.display_name || record.source || 'Unknown source';
    const id = record.id || record.url || `${title.substring(0, 20)}-${year}`;
    const url = record.url || record.doi || record.id || '';
    return { id, title, abstract, authors, year, venue, url };
  };

  const mergeStackWithNewPapers = (basePool, extras) => {
    const merged = [];
    const seen = new Set();
    [...extras, ...basePool].forEach((paper) => {
      const normalized = normalizePaper(paper);
      if (!normalized || seen.has(normalized.id) || !qualityFilter(normalized)) return;
      seen.add(normalized.id);
      merged.push(normalized);
    });
    return sortStackByAffinity(merged);
  };

  const fetchOpenAlexPapers = async (queryTopic) => {
    const targetUrl = `https://api.openalex.org/works?filter=title_and_abstract.search:${encodeURIComponent(queryTopic)}&per_page=12&sort=publication_year:desc`;
    const response = await fetch(targetUrl);
    if (!response.ok) throw new Error(`OpenAlex query failed: ${response.statusText}`);
    const data = await response.json();
    return (data.results || []).map(normalizePaper).filter(Boolean);
  };

  // --- Swipe-Learning Adaptive Logic Engine ---
  const scoreCard = (paper) => {
    let score = 1.0;
    const profile = sGet('ss_affinity_profile') || { topics: {}, authors: {} };
    const textSnapshot = `${paper.title} ${paper.abstract} ${paper.venue || ''}`.toLowerCase();
    const currentYear = new Date().getFullYear();

    // 1. Core Quantum Signal Amplification
    const anchors = {
      'nv center': 1.6,
      'nitrogen-vacancy': 1.6,
      'open quantum': 1.4,
      'decoherence': 1.35,
      'quantum sensing': 1.3,
      'spin coherence': 1.3,
      'dipole engineering': 1.2,
      'comsol': 1.1
    };

    Object.entries(anchors).forEach(([keyword, weight]) => {
      if (textSnapshot.includes(keyword)) score *= weight;
    });

    // 2. Track user-chosen topic affinity
    topics.forEach((topic) => {
      const normalized = topic.name.toLowerCase();
      if (textSnapshot.includes(normalized)) score += 0.35;
    });

    // 3. Swipe learning from saved history
    if (profile.topics) {
      Object.entries(profile.topics).forEach(([topic, weight]) => {
        if (textSnapshot.includes(topic.toLowerCase())) score += weight;
      });
    }

    if (profile.authors && paper.authors) {
      paper.authors.forEach(author => {
        const normalizedAuthor = author.toLowerCase().trim();
        if (profile.authors[normalizedAuthor]) score += profile.authors[normalizedAuthor];
      });
    }

    // 4. Trust and timeliness scoring
    const publicationYear = parseInt(paper.year, 10) || currentYear;
    if (publicationYear > currentYear) score *= 0.6;
    else if (publicationYear === currentYear) score *= 1.35;
    else if (publicationYear === currentYear - 1) score *= 1.15;
    else if (publicationYear < currentYear - 3) score *= 0.75;

    const lowerSource = `${paper.venue || ''}`.toLowerCase();
    const lowerUrl = `${paper.url || ''}`.toLowerCase();
    const genericRepository = ['zenodo', 'ssrn', 'cairn', 'researchgate'];
    if (genericRepository.some(tag => lowerSource.includes(tag) || lowerUrl.includes(tag))) {
      score *= lowerUrl.includes('arxiv.org') || lowerSource.includes('arxiv') ? 0.95 : 0.7;
    }

    if (textSnapshot.includes('arxiv')) score += 0.2;
    if (textSnapshot.includes('experiment')) score += 0.15;

    return score;
  };

  const sortStackByAffinity = (pool) => {
    return [...pool].sort((a, b) => scoreCard(b) - scoreCard(a));
  };

  // --- Action Handlers ---
  const handleSwipe = (isKept) => {
    if (!currentPaper) return;

    let profile = sGet('ss_affinity_profile') || { topics: {}, authors: {} };
    const dynamicDelta = isKept ? 0.35 : -0.2;
    const paperContextText = `${currentPaper.title} ${currentPaper.abstract} ${currentPaper.venue || ''}`.toLowerCase();

    topics.forEach((topic) => {
      const normalized = topic.name.toLowerCase();
      if (paperContextText.includes(normalized)) {
        profile.topics[normalized] = (profile.topics[normalized] || 0) + dynamicDelta;
      }
    });

    if (currentPaper.authors) {
      currentPaper.authors.slice(0, 3).forEach(author => {
        const parsedName = author.toLowerCase().trim();
        profile.authors[parsedName] = (profile.authors[parsedName] || 0) + dynamicDelta;
      });
    }
    persist('ss_affinity_profile', profile);

    if (isKept) {
      const updatedSaved = [...savedPapers];
      if (!updatedSaved.some(p => p.id === currentPaper.id)) {
        updatedSaved.unshift(currentPaper);
        setSavedPapers(updatedSaved);
        persist('ss_saved_stack', updatedSaved);
      }
    }

    setCurrentIndex(prev => prev + 1);
    setAiAnalysis("");
    setStatusMessage(isKept ? 'Saved and learned preferences.' : 'Skipped paper, personalization updated.');
    pushToCloud();
  };

  // --- Desktop Keyboard Event Listeners ---
  useEffect(() => {
    if (!isDesktop || activeTab !== 'stack') return;
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowRight') handleSwipe(true);
      if (e.key === 'ArrowLeft') handleSwipe(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDesktop, currentPaper, activeTab]);

  // --- Feed Delivery Acquisition Management ---
  const triggerFeedHarvest = async () => {
    setSyncLoading(true);
    setStatusMessage('Refreshing harvest and topic-enriched feed...');
    try {
      const feedUrl = settings.harvestUrl || HARVEST_URL;
      const response = await fetch(feedUrl);
      if (!response.ok) throw new Error("Harvest stream connection failed.");
      const rawData = await response.json();
      const normalized = (Array.isArray(rawData) ? rawData : []).map(normalizePaper).filter(qualityFilter);

      let mergedPool = sortStackByAffinity(normalized);
      if (topics.length > 0) {
        const topicResults = await Promise.all(topics.slice(0, 4).map(async (topic) => {
          try {
            return await fetchOpenAlexPapers(topic.name);
          } catch (e) {
            console.warn(`Topic enrichment failed for ${topic.name}:`, e);
            return [];
          }
        }));
        mergedPool = mergeStackWithNewPapers(mergedPool, topicResults.flat());
      }

      setStack(mergedPool);
      persist('ss_papers_pool', mergedPool);
      setCurrentIndex(0);
      setStatusMessage(`Loaded ${mergedPool.length} papers from harvest and tracked topics.`);
    } catch (err) {
      console.error("Failed to harvest external source feed:", err);
      setStatusMessage('Harvest failed; check your settings or network.');
    } finally {
      setSyncLoading(false);
    }
  };

  // --- Real-time On-The-Fly CORS-safe Interest Injection via OpenAlex ---
  const handleAddTopic = async (e) => {
    e.preventDefault();
    if (!newTopicInput.trim()) return;

    const queryTopic = newTopicInput.trim();
    const updatedTopics = [...topics, { id: Date.now().toString(), name: queryTopic, count: 10 }];
    setTopics(updatedTopics);
    persist('ss_tracked_topics', updatedTopics);
    setNewTopicInput("");
    setStatusMessage(`Searching for papers matching “${queryTopic}”...`);

    try {
      setSyncLoading(true);
      const injectedEntries = await fetchOpenAlexPapers(queryTopic);
      const combinedPool = mergeStackWithNewPapers(stack, injectedEntries);
      setStack(combinedPool);
      persist('ss_papers_pool', combinedPool);
      setCurrentIndex(0);
      pushToCloud();
      setStatusMessage(`Added ${injectedEntries.length} topic-driven papers for “${queryTopic}”.`);
    } catch (e) {
      console.warn("Real-time content bypass interception failed:", e);
      setStatusMessage(`Topic enrichment failed for “${queryTopic}”.`);
    } finally {
      setSyncLoading(false);
    }
  };

  // --- Gemini Processing Engine ---
  const triggerGeminiAnalysis = async () => {
    if (!currentPaper) return;
    const apiKey = settings.geminiApiKey?.trim();
    if (!apiKey) {
      setAiAnalysis('No Gemini API key configured. Add a Google AI key in settings to enable analysis.');
      return;
    }

    setAnalyzingId(currentPaper.id);
    setAiAnalysis('Synthesizing laboratory documentation fields via Gemini standard models...');

    const targetEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

    const customizedContextPrompt = `Analyze this advanced physics research entry. Provide a 3-sentence summary profile, structural experimental components matching solid-state implementations (with core focus on NV-centers, spin coherence values, or open quantum system dynamics metrics if presented), and 2 immediate adjacent experiment design ideas for execution.\n\nTitle: ${currentPaper.title}\nAbstract: ${currentPaper.abstract}`;

    try {
      const response = await fetch(targetEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: customizedContextPrompt }] }] })
      });

      if (!response.ok) throw new Error(`Gemini verification response mismatch: ${response.statusText}`);
      const payload = await response.json();
      const outputText = payload.candidates?.[0]?.content?.parts?.[0]?.text || 'Gemini returned an empty response.';
      setAiAnalysis(outputText);
    } catch (err) {
      setAiAnalysis(`Failed to extract automated metrics data rows: ${err.message}`);
    } finally {
      setAnalyzingId(null);
    }
  };

  // --- Authentication Flow Core ---
  const handleMagicLinkLogin = async (e) => {
    e.preventDefault();
    if (!emailInput.trim()) return;
    setSyncLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: emailInput.trim(),
        options: { redirectTo: window.location.origin }
      });
      if (error) throw error;
      alert("Magic Link dispatched! Check your email inbox to synchronize your quantum device matrix.");
      setAuthModalOpen(false);
    } catch (err) {
      alert(`Authentication path block: ${err.message}`);
    } finally {
      setSyncLoading(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    localStorage.clear();
    window.location.reload();
  };

  // --- Dynamic Dashboard Metamap Charts Analytics Prep ---
  const radarData = useMemo(() => {
    const profile = sGet('ss_affinity_profile') || { topics: {} };
    return [
      { subject: 'NV Centers', A: (profile.topics?.['nv-center'] || 0) + 1.2 },
      { subject: 'Decoherence', A: (profile.topics?.['decoherence'] || 0) + 0.9 },
      { subject: 'Sensing', A: (profile.topics?.['quantum sensing'] || 0) + 1.1 },
      { subject: 'Open Quantum', A: (profile.topics?.['open-quantum'] || 0) + 0.7 },
      { subject: 'Optics', A: (profile.topics?.['optics'] || 0) + 0.5 }
    ];
  }, [currentIndex]);

  const rootThemeClass = settings.theme === 'light'
    ? 'bg-slate-100 text-slate-950 selection:bg-cyan-500 selection:text-slate-950'
    : 'bg-slate-950 text-slate-100 selection:bg-cyan-500 selection:text-slate-950';

  return (
    <div className={`${rootThemeClass} min-h-screen flex flex-col font-sans antialiased`}>
      {isDesktop ? (
        /* =========================================================================
           DESKTOP INTERFACE WORKSPACE (Multi-Pane Lab Terminal Layout)
           ========================================================================= */
        <div className="flex flex-1 h-screen overflow-hidden">
          
          {/* COLUMN 1: CONTROLS & MONITOR MATRIX */}
          <div className="w-80 bg-slate-900 border-r border-slate-800 flex flex-col justify-between p-5 z-20 shadow-2xl">
            <div className="space-y-6 overflow-y-auto max-h-[calc(100vh-100px)] pr-1">
              {/* Logo Brand Header */}
              <div className="flex items-center space-x-2.5">
                <div className="h-9 w-9 bg-gradient-to-tr from-cyan-500 to-blue-600 rounded-xl flex items-center justify-center font-bold text-slate-950 shadow-lg shadow-cyan-500/20">⚛</div>
                <div>
                  <h1 className="text-md font-black tracking-wider text-white">SPINSTACK</h1>
                  <span className="text-[10px] text-cyan-400 font-mono tracking-widest block uppercase">Quantum Feed Engine</span>
                </div>
              </div>

              {/* View Configuration Toggles */}
              <div className="grid grid-cols-2 gap-2 p-1 bg-slate-950 rounded-lg border border-slate-800/80">
                <button 
                  onClick={() => setActiveTab('stack')}
                  className={`py-1.5 text-xs font-medium rounded transition flex items-center justify-center gap-1.5 ${activeTab === 'stack' ? 'bg-slate-800 text-cyan-400 font-bold border border-slate-700' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  <Layers size={13} /> Active Stack
                </button>
                <button 
                  onClick={() => setActiveTab('saved')}
                  className={`py-1.5 text-xs font-medium rounded transition flex items-center justify-center gap-1.5 ${activeTab === 'saved' ? 'bg-slate-800 text-cyan-400 font-bold border border-slate-700' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  <Bookmark size={13} /> Vault ({savedPapers.length})
                </button>
              </div>

              {/* Topic Discovery Form and Badges */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Dynamic Interest Targets</h3>
                  <span className="text-[10px] bg-slate-950 border border-slate-800 text-slate-500 px-1.5 py-0.2 rounded font-mono">CORS Safe</span>
                </div>
                <form onSubmit={handleAddTopic} className="flex gap-2">
                  <div className="relative flex-1">
                    <input 
                      type="text" 
                      value={newTopicInput}
                      onChange={e => setNewTopicInput(e.target.value)}
                      placeholder="Inject custom topic matrix..." 
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-7 pr-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono transition"
                    />
                    <Search className="absolute left-2.5 top-2.5 text-slate-600" size={12} />
                  </div>
                  <button type="submit" className="bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold px-3 rounded-lg text-xs transition flex items-center">
                    <Plus size={14} />
                  </button>
                </form>
                <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pr-1">
                  {topics.map(t => (
                    <div key={t.id} className="flex items-center gap-1 text-[11px] font-mono px-2 py-1 bg-slate-950/80 border border-slate-800/80 rounded-md text-slate-300">
                      <span className="text-cyan-500/80">#</span>{t.name}
                    </div>
                  ))}
                </div>
              </div>

              {/* Dynamic Affinity Metamap Graph Panel */}
              <div className="space-y-2 pt-2 border-t border-slate-800/60">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Sliders size={12} className="text-cyan-400" /> Swipe Learning Vector Topology
                </h4>
                <div className="h-40 bg-slate-950 rounded-xl border border-slate-800/60 p-1 flex items-center justify-center">
                  <ResponsiveContainer width="100%" height="100%">
                    <RadarChart cx="50%" cy="50%" radius="80%" data={radarData}>
                      <PolarGrid stroke="#1e293b" />
                      <PolarAngleAxis dataKey="subject" tick={{ fill: '#94a3b8', fontSize: 9, fontFamily: 'monospace' }} />
                      <Radar name="Affinity Profile" dataKey="A" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.15} />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* System Queue Diagnostics */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 shadow-inner space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider block">Remaining Inactive Queue</span>
                <div className="text-3xl font-mono font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-400">
                  {Math.max(0, stack.length - currentIndex)} <span className="text-xs text-slate-600 font-normal">records remaining</span>
                </div>
              </div>
            </div>

            {/* Downstream Configuration Base Panel */}
            <div className="pt-4 border-t border-slate-800 flex flex-col gap-3 text-xs">
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  {userEmail ? (
                    <div className="flex flex-col truncate max-w-[180px]">
                      <span className="text-[10px] text-slate-500 uppercase font-mono">Linked Device Identity</span>
                      <span className="text-slate-300 font-mono truncate">{userEmail}</span>
                    </div>
                  ) : (
                    <button 
                      onClick={() => setAuthModalOpen(true)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-950 hover:bg-slate-800 rounded-lg text-slate-300 border border-slate-800 transition text-xs font-mono"
                    >
                      <Cloud size={13} className="text-cyan-400" /> Establish Sync Handshake
                    </button>
                  )}
                  <button 
                    onClick={triggerFeedHarvest} 
                    disabled={syncLoading}
                    className="p-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg transition text-slate-400 disabled:opacity-40"
                    title="Force Reload Latest Feed"
                  >
                    <RefreshCw size={13} className={syncLoading ? 'animate-spin text-cyan-400' : ''} />
                  </button>
                </div>
                <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950 p-3 text-[10px] text-slate-400">
                  <label className="block">
                    <span className="text-slate-500 uppercase tracking-widest font-mono">Harvest URL</span>
                    <input
                      type="text"
                      value={settings.harvestUrl}
                      onChange={(e) => setSettings({ ...settings, harvestUrl: e.target.value })}
                      className="mt-2 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-[11px] text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-500 uppercase tracking-widest font-mono">Gemini API Key</span>
                    <input
                      type="text"
                      value={settings.geminiApiKey}
                      onChange={(e) => setSettings({ ...settings, geminiApiKey: e.target.value })}
                      placeholder="Paste your Google AI Studio key"
                      className="mt-2 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-[11px] text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-500 uppercase tracking-widest font-mono">Theme</span>
                    <select
                      value={settings.theme}
                      onChange={(e) => setSettings({ ...settings, theme: e.target.value })}
                      className="mt-2 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-[11px] text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </select>
                  </label>
                </div>
              </div>
              {statusMessage && (
                <div className="text-[10px] text-slate-400 font-mono">{statusMessage}</div>
              )}
              {userEmail && (
                <button onClick={handleSignOut} className="text-left text-[10px] text-rose-500/80 hover:text-rose-400 underline font-mono">
                  Disconnect device parameters
                </button>
              )}
            </div>
          </div>

          {/* COLUMN 2: READING ARENA CORE */}
          <div className="flex-1 bg-slate-950 flex flex-col p-8 overflow-y-auto z-10 relative">
            <div className="max-w-3xl mx-auto w-full space-y-6 my-auto">
              {activeTab === 'stack' ? (
                <>
                  {/* Workspace Command Headers */}
                  <div className="flex justify-between items-center bg-slate-900 border border-slate-800/80 p-4 rounded-xl shadow-xl">
                    <button 
                      onClick={() => handleSwipe(false)} 
                      disabled={!currentPaper}
                      className="px-4 py-2 bg-rose-950/20 hover:bg-rose-900/40 text-rose-400 rounded-lg text-xs font-bold border border-rose-900/40 transition flex items-center gap-2 disabled:opacity-30"
                    >
                      <X size={14} /> <span>Skip Frame</span> <kbd className="bg-slate-950 px-1 text-[10px] text-slate-500 rounded font-mono border border-slate-800">Left</kbd>
                    </button>
                    <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500 font-mono flex items-center gap-1.5">
                      <BookOpen size={11} className="text-cyan-500" /> Pipeline Index {currentIndex + 1} of {stack.length}
                    </span>
                    <button 
                      onClick={() => handleSwipe(true)} 
                      disabled={!currentPaper}
                      className="px-4 py-2 bg-emerald-950/20 hover:bg-emerald-900/40 text-emerald-400 rounded-lg text-xs font-bold border border-emerald-900/40 transition flex items-center gap-2 disabled:opacity-30"
                    >
                      <span>Keep Vector</span> <kbd className="bg-slate-950 px-1 text-[10px] text-slate-500 rounded font-mono border border-slate-800">Right</kbd> <Check size={14} />
                    </button>
                  </div>

                  {/* Primary Target Data Sheet Document */}
                  {currentPaper ? (
                    <div className="bg-slate-900/40 rounded-2xl border border-slate-800 p-8 space-y-6 shadow-2xl relative overflow-hidden group">
                      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                      <div className="space-y-4">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] font-mono bg-cyan-950/60 text-cyan-400 border border-cyan-900/60 px-2.5 py-0.5 rounded-md flex items-center gap-1">
                            <Layers size={10} /> {currentPaper.venue || "Solid-State Archive"}
                          </span>
                          <span className="text-[10px] font-mono bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded-md flex items-center gap-1">
                            <Zap size={10} className="text-amber-400" /> Score Weights: {scoreCard(currentPaper).toFixed(2)}
                          </span>
                          <span className="text-[10px] font-mono bg-slate-950 border border-slate-800 text-slate-400 px-2 py-0.5 rounded-md ml-auto">
                            {currentPaper.year || 2026}
                          </span>
                        </div>
                        <h2 className="text-2xl font-black text-white tracking-tight leading-snug">
                          {currentPaper.title}
                        </h2>
                        <div className="flex items-start gap-1.5">
                          <Award size={13} className="text-slate-500 mt-0.5 flex-shrink-0" />
                          <p className="text-xs font-semibold text-slate-400 italic leading-relaxed">
                            {currentPaper.authors?.join(', ')}
                          </p>
                        </div>
                      </div>
                      <hr className="border-slate-800/80" />
                      <div className="space-y-2">
                        <h4 className="text-xs font-bold uppercase tracking-widest text-slate-400 font-mono">Abstract Core Metadata</h4>
                        <p className="text-slate-300 text-sm leading-relaxed text-justify font-normal selection:bg-cyan-500/30">
                          {currentPaper.abstract}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-24 bg-slate-900/10 border border-dashed border-slate-800 rounded-2xl p-8 space-y-3">
                      <p className="text-slate-500 font-mono text-sm">All loaded research pathways have been indexed or cleared.</p>
                      <button onClick={triggerFeedHarvest} className="text-xs text-cyan-400 hover:underline font-mono flex items-center gap-1.5 mx-auto">
                        <RefreshCw size={12} /> Pull clean baseline dataset down
                      </button>
                    </div>
                  )}
                </>
              ) : (
                /* Saved Vault View Viewpane */
                <div className="space-y-4">
                  <div className="flex justify-between items-center border-b border-slate-800 pb-3">
                    <h2 className="text-lg font-black tracking-tight text-white flex items-center gap-2">
                      <Bookmark size={18} className="text-cyan-400" /> Preserved Quantum Knowledge Vault
                    </h2>
                    <span className="text-xs font-mono text-slate-500">{savedPapers.length} items cataloged</span>
                  </div>
                  {savedPapers.length === 0 ? (
                    <div className="text-center py-20 text-slate-600 font-mono text-xs">No vector entries have been committed to storage vaults yet.</div>
                  ) : (
                    <div className="space-y-3 max-h-[calc(100vh-220px)] overflow-y-auto pr-2">
                      {savedPapers.map((paper, idx) => (
                        <div key={paper.id || idx} className="p-4 bg-slate-900/60 border border-slate-800/80 rounded-xl space-y-2 relative group hover:border-slate-700 transition">
                          <div className="flex justify-between items-start gap-4">
                            <h3 className="text-sm font-bold text-white leading-snug group-hover:text-cyan-400 transition">{paper.title}</h3>
                            <button 
                              onClick={() => {
                                const cut = savedPapers.filter(p => p.id !== paper.id);
                                setSavedPapers(cut);
                                persist('ss_saved_stack', cut);
                                pushToCloud();
                              }}
                              className="text-slate-600 hover:text-rose-400 transition p-1"
                              title="Purge from vault"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                          <p className="text-[11px] text-slate-400 truncate font-mono">{paper.authors?.join(', ')}</p>
                          <div className="flex gap-2 text-[10px] font-mono text-slate-500 pt-1">
                            <span>{paper.venue || "Archive Layer"}</span>
                            <span>•</span>
                            <span>{paper.year || 2026}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* COLUMN 3: CO-PILOT ANALYSIS SUITE */}
          <div className="w-96 bg-slate-900 border-l border-slate-800 flex flex-col p-5 z-20 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <Sparkles size={13} className="text-cyan-400" /> Gemini Inference Matrix
              </span>
              {currentPaper && activeTab === 'stack' && (
                <button 
                  onClick={triggerGeminiAnalysis}
                  disabled={analyzingId === currentPaper.id}
                  className="text-[11px] bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 text-slate-950 font-bold px-3 py-1 rounded-md transition tracking-wide flex items-center gap-1 shadow-md shadow-cyan-600/10"
                >
                  {analyzingId === currentPaper.id ? "Synthesizing..." : "Execute Build Summary"}
                </button>
              )}
            </div>
            
            <div className="flex-1 mt-4 bg-slate-950/80 border border-slate-800/80 rounded-xl p-4 overflow-y-auto text-xs font-mono leading-relaxed text-slate-300 whitespace-pre-wrap selection:bg-cyan-500/20">
              {aiAnalysis ? aiAnalysis : (
                <div className="text-slate-600 space-y-4 font-sans p-2">
                  <p className="font-mono text-xs">System ready to map laboratory insights.</p>
                  <div className="space-y-2 border-l-2 border-slate-800 pl-3">
                    <p className="text-[11px]">Executing builds automatically yields:</p>
                    <ul className="list-disc list-inside text-[11px] space-y-1 text-slate-500">
                      <li>3-Sentence Extraction Mapping</li>
                      <li>Solid-State Hardware Parameters Matrix</li>
                      <li>Adjacent Experiment Generation Scenarios</li>
                    </ul>
                  </div>
                </div>
              )}
            </div>
            
            <div className="mt-4 bg-slate-950 p-3 rounded-lg border border-slate-800/60 text-[10px] font-mono text-slate-500 flex flex-col gap-1">
              <span>Target Node: gemini-flash-latest</span>
              <span>Proxy Handshake Address: direct-embedded</span>
            </div>
          </div>

        </div>
      ) : (
        /* =========================================================================
           MOBILE INTERFACE (High-Contrast Thumb Swiping Canvas View)
           ========================================================================= */
        <div className="flex flex-col flex-1 justify-between pb-24 z-10">
          
          {/* Mobile Status Header */}
          <header className="p-4 bg-slate-900 border-b border-slate-800 sticky top-0 z-50 flex justify-between items-center shadow-md">
            <div className="flex items-center gap-2">
              <span className="h-6 w-6 bg-cyan-500 rounded-lg flex items-center justify-center font-bold text-slate-950 text-xs">⚛</span>
              <span className="font-black text-white tracking-wider text-xs">SPINSTACK MOBILE</span>
            </div>
            
            {/* View Switching Bar */}
            <div className="flex bg-slate-950 rounded-md border border-slate-800 p-0.5 text-[10px]">
              <button 
                onClick={() => setActiveTab('stack')}
                className={`px-2 py-0.5 rounded font-mono ${activeTab === 'stack' ? 'bg-slate-800 text-cyan-400 font-bold' : 'text-slate-500'}`}
              >
                Stack
              </button>
              <button 
                onClick={() => setActiveTab('saved')}
                className={`px-2 py-0.5 rounded font-mono ${activeTab === 'saved' ? 'bg-slate-800 text-cyan-400 font-bold' : 'text-slate-500'}`}
              >
                Vault({savedPapers.length})
              </button>
            </div>
          </header>

          {/* Mobile Dynamic Space Canvas */}
          <main className="flex-1 p-4 flex items-center justify-center max-w-md mx-auto w-full">
            {activeTab === 'stack' ? (
              currentPaper ? (
                <div className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-2xl relative overflow-hidden flex flex-col justify-between max-h-[75vh]">
                  <div className="space-y-3 overflow-y-auto pr-1 flex-1">
                    <div className="flex justify-between items-center text-[9px] font-mono text-slate-500">
                      <span className="truncate max-w-[150px] bg-slate-950 px-2 py-0.5 border border-slate-800 rounded text-cyan-400">
                        {currentPaper.venue || "arXiv Repository"}
                      </span>
                      <span>{currentPaper.year || 2026}</span>
                    </div>
                    <h2 className="text-base font-black text-white leading-snug tracking-tight">
                      {currentPaper.title}
                    </h2>
                    <p className="text-[10px] text-slate-400 italic leading-normal truncate">
                      {currentPaper.authors?.join(', ')}
                    </p>
                    <hr className="border-slate-800" />
                    <p className="text-slate-300 text-xs leading-relaxed text-justify font-normal">
                      {currentPaper.abstract}
                    </p>
                  </div>
                  
                  {/* Embedded Mobile Inline AI Handler Module */}
                  <div className="pt-3 border-t border-slate-800/80 space-y-2 flex-shrink-0">
                    <button 
                      onClick={triggerGeminiAnalysis}
                      disabled={analyzingId === currentPaper.id}
                      className="w-full py-2 bg-slate-950 border border-slate-800 hover:bg-slate-800 text-cyan-400 text-[10px] font-mono tracking-wider rounded-xl transition flex items-center justify-center gap-1.5"
                    >
                      <Sparkles size={11} /> {analyzingId === currentPaper.id ? "Extracting insights..." : "⚡ Query Mobile AI Breakdown"}
                    </button>
                    {aiAnalysis && (
                      <div className="bg-slate-950 p-3 rounded-lg text-[10px] font-mono text-slate-400 max-h-24 overflow-y-auto border border-slate-800/60 leading-normal whitespace-pre-wrap">
                        {aiAnalysis}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-center p-8 text-slate-600 font-mono text-xs">All card structures parsed.</div>
              )
            ) : (
              /* Vault View Screen on Mobile */
              <div className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-2xl flex flex-col h-[70vh]">
                <span className="text-[10px] uppercase font-mono tracking-widest text-slate-500 block border-b border-slate-800 pb-2 mb-2">Preserved Vault Index</span>
                {savedPapers.length === 0 ? (
                  <div className="text-center my-auto text-slate-600 font-mono text-xs">No elements committed.</div>
                ) : (
                  <div className="space-y-2 overflow-y-auto flex-1 pr-1">
                    {savedPapers.map((paper, idx) => (
                      <div key={paper.id || idx} className="p-3 bg-slate-950 rounded-xl border border-slate-800/80 flex justify-between items-center gap-3">
                        <div className="truncate flex-1">
                          <h4 className="text-xs font-bold text-white truncate">{paper.title}</h4>
                          <span className="text-[9px] font-mono text-slate-500 truncate block">{paper.venue} • {paper.year}</span>
                        </div>
                        <button 
                          onClick={() => {
                            const rem = savedPapers.filter(p => p.id !== paper.id);
                            setSavedPapers(rem);
                            persist('ss_saved_stack', rem);
                          }}
                          className="text-rose-500/70 p-1"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </main>

          {/* Fixed Thumb Controls Footer Row for Mobile Swiping */}
          {activeTab === 'stack' && (
            <div className="fixed bottom-0 left-0 right-0 p-4 bg-slate-900/95 border-t border-slate-800/80 flex justify-around items-center backdrop-blur-md z-50 shadow-2xl">
              <button 
                onClick={() => handleSwipe(false)}
                disabled={!currentPaper}
                className="w-14 h-14 bg-rose-950/20 border border-rose-900/50 rounded-full flex items-center justify-center text-rose-400 font-black text-xl active:scale-90 transition disabled:opacity-20 shadow-lg shadow-rose-950/20"
              >
                ✕
              </button>
              <div className="text-center font-mono">
                <span className="text-[9px] uppercase tracking-widest text-slate-500 block">Queue Matrix</span>
                <span className="text-xs font-black text-cyan-400">{Math.max(0, stack.length - currentIndex)} left</span>
              </div>
              <button 
                onClick={() => handleSwipe(true)}
                disabled={!currentPaper}
                className="w-14 h-14 bg-emerald-950/20 border border-emerald-900/50 rounded-full flex items-center justify-center text-emerald-400 font-black text-xl active:scale-90 transition disabled:opacity-20 shadow-lg shadow-emerald-950/20"
              >
                ✓
              </button>
            </div>
          )}
        </div>
      )}

      {/* =========================================================================
         GLOBAL COMPONENT PORTAL GLOBAL MODALS (Magic Link Sign-in Overlay)
         ========================================================================= */
      authModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-sm p-6 space-y-4 shadow-2xl">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-white tracking-wide flex items-center gap-2">
                <Cloud size={16} className="text-cyan-400" /> Establish Sync Parameters
              </h3>
              <button onClick={() => setAuthModalOpen(false)} className="text-slate-500 hover:text-slate-300">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed font-sans">
              Enter your email coordinates to send a secure magic validation connection string link directly to your device matrices.
            </p>
            <form onSubmit={handleMagicLinkLogin} className="space-y-3">
              <input 
                type="email" 
                required
                value={emailInput}
                onChange={e => setEmailInput(e.target.value)}
                placeholder="physicist@institution.edu" 
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-cyan-500 transition"
              />
              <button 
                type="submit" 
                disabled={syncLoading}
                className="w-full py-2 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs rounded-xl transition flex items-center justify-center gap-2 disabled:opacity-50 shadow-md shadow-cyan-600/10"
              >
                {syncLoading ? "Dispatched string..." : "Transmit Connection Link"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
