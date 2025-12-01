import { useEffect, useRef, useState } from 'react';
import './index.css';

// --- Types ---
interface Bubble {
  id: number;
  x: number;
  y: number;
  r: number;
  speed: number;
  opacity: number;
}

// --- Configuration ---
const CONFIG = {
  loopEndTime: 7.0,      // 1단계: 0~7초 구간 반복
  vocalStartTime: 17.0,  // 2단계: 음악 시작 시간 (onlyclock 기준)
  gaugeSpeed: 0.15,      // 게이지 차오르는 속도 (Input Sensitivity) - Stage 1
  vocalGaugeSpeed: 0.15, // Vocal control 단계 게이지 속도 (10초에 최대치)
  decayRate: 0.5,        // 게이지 줄어드는 속도
  fadeOutTime: 10.0,     // Reset 시 페이드아웃 시간 (초)
  inputKeys: [' ', 'Enter'],
  // 음악 폴더 목록 (자동 인식)
  musicFolders: ['AtYourBest', 'HouseOfCards', 'Misty']
};

function App() {
  // --- UI States ---
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState("DISCONNECTED");
  const [isLeaning, setIsLeaning] = useState(false);
  const [stage, setStage] = useState<0 | 1 | 2>(0); // 0:Ready, 1:Loop/Trans, 2:VocalActive
  const [errorMessage, setErrorMessage] = useState("");

  // --- Logic Refs ---
  const audioRef = useRef<{
    ctx: AudioContext | null;
    clockSrc: AudioBufferSourceNode | null;
    otherSrc: AudioBufferSourceNode | null;
    bassSrc: AudioBufferSourceNode | null;
    drumsSrc: AudioBufferSourceNode | null;
    vocalsSrc: AudioBufferSourceNode | null;
    gainClock: GainNode | null;
    gainOther: GainNode | null;
    gainBass: GainNode | null;
    gainDrums: GainNode | null;
    gainVocals: GainNode | null;
    startTime: number; // onlyclock 시작 시간 (Context Time)
  }>({
    ctx: null, clockSrc: null, otherSrc: null, bassSrc: null, drumsSrc: null, vocalsSrc: null,
    gainClock: null, gainOther: null, gainBass: null, gainDrums: null, gainVocals: null, startTime: 0
  });

  const buffersRef = useRef<{ clock: AudioBuffer | null }>({
    clock: null
  });

  const stateRef = useRef({
    gauge: 0,            // 0 ~ 100 (Logical Value)
    visualGauge: 0,      // 0 ~ 100 (Smoothed for Visuals)
    isLooping: true,     // Loop Mode Active?
    vocalActive: false,  // 17s passed?
    isLeaning: false,    // Input state (ref to avoid closure issues)
  });

  const requestRef = useRef<number | undefined>(undefined);
  
  // Visual Refs
  const pathRef1 = useRef<SVGPathElement>(null);
  const pathRef2 = useRef<SVGPathElement>(null);
  const pathRef3 = useRef<SVGPathElement>(null);
  const liquidGroupRef = useRef<SVGGElement>(null);
  
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const bubbleIdRef = useRef(0);
  const bubblesRef = useRef<Bubble[]>([]); // Mutable for loop
  const [isPaused, setIsPaused] = useState(false);
  const [selectedMusic, setSelectedMusic] = useState<string>(CONFIG.musicFolders[0]);
  const [musicBuffers, setMusicBuffers] = useState<{
    [key: string]: {
      other: AudioBuffer | null;
      bass: AudioBuffer | null;
      drums: AudioBuffer | null;
      vocals: AudioBuffer | null;
    }
  }>({});

  // --- 1. Audio Loading ---
  const loadFile = async (ctx: AudioContext, url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}`);
    return await ctx.decodeAudioData(await res.arrayBuffer());
  };

  // 음악 폴더의 모든 트랙 로드
  const loadMusicFolder = async (ctx: AudioContext, folderName: string) => {
    const extensions = ['.wav', '.flac'];
    let other: AudioBuffer | null = null;
    let bass: AudioBuffer | null = null;
    let drums: AudioBuffer | null = null;
    let vocals: AudioBuffer | null = null;

    for (const ext of extensions) {
      try {
        if (!other) other = await loadFile(ctx, `/${folderName}/other${ext}`);
      } catch {}
      try {
        if (!bass) bass = await loadFile(ctx, `/${folderName}/bass${ext}`);
      } catch {}
      try {
        if (!drums) drums = await loadFile(ctx, `/${folderName}/drums${ext}`);
      } catch {}
      try {
        if (!vocals) vocals = await loadFile(ctx, `/${folderName}/vocals${ext}`);
      } catch {}
    }

    return { other, bass, drums, vocals };
  };

  const initAudio = async () => {
    if (isReady || isLoading) return;
    setIsLoading(true);
    try {
      setStatusText("LOADING...");
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();

      // onlyclock.wav 로드
      const clockBuf = await loadFile(ctx, '/onlyclock.wav');
      buffersRef.current = { clock: clockBuf };

      // 선택된 음악만 먼저 로드
      const musicBuffersData: typeof musicBuffers = {};
      musicBuffersData[selectedMusic] = await loadMusicFolder(ctx, selectedMusic);
      setMusicBuffers(musicBuffersData);

      // 나머지 음악은 백그라운드에서 로드
      Promise.all(
        CONFIG.musicFolders
          .filter(folder => folder !== selectedMusic)
          .map(async (folder) => {
            const buffers = await loadMusicFolder(ctx, folder);
            setMusicBuffers(prev => ({ ...prev, [folder]: buffers }));
          })
      ).catch(console.error);

      // Node Setup
      const gainClock = ctx.createGain();
      const gainOther = ctx.createGain();
      const gainBass = ctx.createGain();
      const gainDrums = ctx.createGain();
      const gainVocals = ctx.createGain();
      
      // Initial Volumes
      gainClock.gain.value = 0; // Controlled by gauge in Stage 1
      gainOther.gain.value = 0; // Starts at 17s
      gainBass.gain.value = 0;
      gainDrums.gain.value = 0;
      gainVocals.gain.value = 0;

      gainClock.connect(ctx.destination);
      gainOther.connect(ctx.destination);
      gainBass.connect(ctx.destination);
      gainDrums.connect(ctx.destination);
      gainVocals.connect(ctx.destination);

      audioRef.current = { 
        ctx, clockSrc: null, otherSrc: null, bassSrc: null, drumsSrc: null, vocalsSrc: null,
        gainClock, gainOther, gainBass, gainDrums, gainVocals, startTime: 0 
      };

      startMusic(ctx, clockBuf);

    } catch (e: any) {
      console.error(e);
      setErrorMessage(e.message);
      setStatusText("ERROR");
    } finally {
      setIsLoading(false);
    }
  };

  const startMusic = (ctx: AudioContext, clockBuf: AudioBuffer) => {
    const { gainClock } = audioRef.current;
    if (!gainClock) return;

    // Calculate exact sample positions for seamless loop
    const sampleRate = clockBuf.sampleRate;
    const loopStartSample = 0;
    const loopEndSample = Math.floor(CONFIG.loopEndTime * sampleRate);
    
    // 1. Clock Source (Loop with exact sample positions)
    const clockSrc = ctx.createBufferSource();
    clockSrc.buffer = clockBuf;
    clockSrc.loop = true;
    clockSrc.loopStart = loopStartSample / sampleRate;
    clockSrc.loopEnd = loopEndSample / sampleRate;
    clockSrc.connect(gainClock);

    const now = ctx.currentTime;
    clockSrc.start(now);
    
    // Save state
    audioRef.current.clockSrc = clockSrc;
    audioRef.current.startTime = now;

    // Don't schedule music here - wait for releaseLoop

    setIsReady(true);
    setStage(1);
    setStatusText("SYNC TIME (HOLD SPACE)");

    // Game loop should already be running from mount effect
  };

  const scheduleMusicAt17s = (ctx: AudioContext, musicStartAt: number) => {
    const { gainOther, gainBass, gainDrums, gainVocals } = audioRef.current;
    if (!gainOther || !gainBass || !gainDrums || !gainVocals) return;

    const currentMusic = musicBuffers[selectedMusic];
    if (!currentMusic || !currentMusic.other) return;

    const now = ctx.currentTime;
    const delay = Math.max(0, musicStartAt - now);

    // Create sources for all tracks
    const otherSrc = ctx.createBufferSource();
    otherSrc.buffer = currentMusic.other!;
    otherSrc.connect(gainOther);
    otherSrc.start(musicStartAt);

    const bassSrc = ctx.createBufferSource();
    if (currentMusic.bass) {
      bassSrc.buffer = currentMusic.bass;
      bassSrc.connect(gainBass);
      bassSrc.start(musicStartAt);
    }

    const drumsSrc = ctx.createBufferSource();
    if (currentMusic.drums) {
      drumsSrc.buffer = currentMusic.drums;
      drumsSrc.connect(gainDrums);
      drumsSrc.start(musicStartAt);
    }

    const vocalsSrc = ctx.createBufferSource();
    if (currentMusic.vocals) {
      vocalsSrc.buffer = currentMusic.vocals;
      vocalsSrc.connect(gainVocals);
      vocalsSrc.start(musicStartAt);
    }

    // Update refs
    audioRef.current.otherSrc = otherSrc;
    audioRef.current.bassSrc = bassSrc;
    audioRef.current.drumsSrc = drumsSrc;
    audioRef.current.vocalsSrc = vocalsSrc;

    // Start others at full volume
    gainOther.gain.setValueAtTime(1.0, musicStartAt);

    // Schedule state change
    if (delay > 0) {
      setTimeout(() => {
        stateRef.current.vocalActive = true;
        setStage(2);
        setStatusText("VOCAL CONTROL ACTIVE");
        stateRef.current.gauge = 0;
      }, delay * 1000);
    } else {
      // Start immediately
      stateRef.current.vocalActive = true;
      setStage(2);
      setStatusText("VOCAL CONTROL ACTIVE");
      stateRef.current.gauge = 0;
    }
  };

  // --- 2. Logic: Play/Pause/Stop Controls ---
  const handlePlay = async () => {
    const { ctx } = audioRef.current;
    if (!ctx) return;
    
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    setIsPaused(false);
  };

  const handlePause = async () => {
    const { ctx } = audioRef.current;
    if (!ctx) return;
    
    if (ctx.state === 'running') {
      await ctx.suspend();
    }
    setIsPaused(true);
  };

  const handleStop = () => {
    resetToStage1();
    setIsPaused(false);
  };

  // --- 2. Logic: Reset to Stage 1 ---
  const resetToStage1 = () => {
    const { ctx, clockSrc, otherSrc, bassSrc, drumsSrc, vocalsSrc, gainClock, gainOther, gainBass, gainDrums, gainVocals } = audioRef.current;
    if (!ctx || !clockSrc || !gainClock) return;

    // Fade out volume gradually (10 seconds)
    const fadeOutTime = CONFIG.fadeOutTime;
    const now = ctx.currentTime;
    
    // 현재 볼륨 값 가져오기
    const currentClockVol = gainClock.gain.value;
    
    // 선형 페이드아웃 (linearRampToValueAtTime 사용)
    gainClock.gain.cancelScheduledValues(now);
    gainClock.gain.setValueAtTime(currentClockVol, now);
    gainClock.gain.linearRampToValueAtTime(0, now + fadeOutTime);
    
    if (gainOther) {
      const currentOtherVol = gainOther.gain.value;
      gainOther.gain.cancelScheduledValues(now);
      gainOther.gain.setValueAtTime(currentOtherVol, now);
      gainOther.gain.linearRampToValueAtTime(0, now + fadeOutTime);
    }
    if (gainBass) {
      const currentBassVol = gainBass.gain.value;
      gainBass.gain.cancelScheduledValues(now);
      gainBass.gain.setValueAtTime(currentBassVol, now);
      gainBass.gain.linearRampToValueAtTime(0, now + fadeOutTime);
    }
    if (gainDrums) {
      const currentDrumsVol = gainDrums.gain.value;
      gainDrums.gain.cancelScheduledValues(now);
      gainDrums.gain.setValueAtTime(currentDrumsVol, now);
      gainDrums.gain.linearRampToValueAtTime(0, now + fadeOutTime);
    }
    if (gainVocals) {
      const currentVocalsVol = gainVocals.gain.value;
      gainVocals.gain.cancelScheduledValues(now);
      gainVocals.gain.setValueAtTime(currentVocalsVol, now);
      gainVocals.gain.linearRampToValueAtTime(0, now + fadeOutTime);
    }

    // After fade out completes, stop sources and reset everything
    setTimeout(() => {
      // Stop audio sources after fade out
      if (otherSrc) {
        try { otherSrc.stop(); } catch (e) {}
      }
      if (bassSrc) {
        try { bassSrc.stop(); } catch (e) {}
      }
      if (drumsSrc) {
        try { drumsSrc.stop(); } catch (e) {}
      }
      if (vocalsSrc) {
        try { vocalsSrc.stop(); } catch (e) {}
      }
      if (clockSrc) {
        try { clockSrc.stop(); } catch (e) {}
      }
      
      const { clock } = buffersRef.current;
      if (!clock) return;

      // Create new clock source
      const newClockSrc = ctx.createBufferSource();
      newClockSrc.buffer = clock;
      newClockSrc.loop = true;
      newClockSrc.loopStart = 0;
      newClockSrc.loopEnd = CONFIG.loopEndTime;
      newClockSrc.connect(gainClock);

      const startTime = ctx.currentTime;
      newClockSrc.start(startTime);

      // Update refs
      audioRef.current.clockSrc = newClockSrc;
      audioRef.current.otherSrc = null;
      audioRef.current.bassSrc = null;
      audioRef.current.drumsSrc = null;
      audioRef.current.vocalsSrc = null;
      audioRef.current.startTime = startTime;

      // Reset state
      stateRef.current.isLooping = true;
      stateRef.current.vocalActive = false;
      stateRef.current.gauge = 0;
      stateRef.current.visualGauge = 0;

      // Update UI
      setStage(1);
      setStatusText("SYNC TIME (HOLD SPACE)");
      
      // Reset gain nodes
      if (audioRef.current.gainOther) audioRef.current.gainOther.gain.value = 0;
      if (audioRef.current.gainBass) audioRef.current.gainBass.gain.value = 0;
      if (audioRef.current.gainDrums) audioRef.current.gainDrums.gain.value = 0;
      if (audioRef.current.gainVocals) audioRef.current.gainVocals.gain.value = 0;
    }, fadeOutTime * 1000);
  };

  // --- 2. Logic: Release Loop & Schedule Music ---
  const releaseLoop = () => {
    const { ctx, clockSrc, startTime } = audioRef.current;
    if (!ctx || !clockSrc) return;

    // Break Loop
    clockSrc.loop = false;
    stateRef.current.isLooping = false;
    setStatusText("SYNC COMPLETE...");

    // Calculate when to start music (17 seconds from clock start)
    const now = ctx.currentTime;
    const elapsed = now - startTime;
    const timeUntil17s = CONFIG.vocalStartTime - elapsed;
    
    if (timeUntil17s > 0) {
      // Schedule music at 17s
      scheduleMusicAt17s(ctx, now + timeUntil17s);
    } else {
      // Already past 17s, start immediately
      scheduleMusicAt17s(ctx, now);
    }
  };

  // --- 3. Animation Helpers ---
  const createWavePath = (time: number, offset: number, amp: number, freq: number) => {
    const width = 300;
    const points = [];
    for (let x = 0; x <= width; x += 10) {
      const y = Math.sin(x * freq + time + offset) * amp
        + Math.sin(x * freq * 2.1 + time * 0.5) * (amp * 0.3);
      points.push([x, y]);
    }
    let d = `M0,${points[0][1]}`;
    for (let i = 1; i < points.length; i++) {
      d += ` L${points[i][0]},${points[i][1]}`;
    }
    d += ` V350 H0 Z`;
    return d;
  };

  const updateBubbles = (visualLevel: number) => {
    // Spawn bubbles if leaning
    if (stateRef.current.isLooping || stateRef.current.vocalActive) {
        if (stateRef.current.isLeaning && Math.random() < 0.1) {
            const id = bubbleIdRef.current++;
            bubblesRef.current.push({
                id,
                x: 50 + Math.random() * 200,
                y: 300,
                r: 2 + Math.random() * 4,
                speed: 1 + Math.random() * 2,
                opacity: 0.4 + Math.random() * 0.4
            });
        }
    }

    const liquidY = 300 - (visualLevel * 300);

    bubblesRef.current.forEach(b => {
      b.y -= b.speed;
      b.x += Math.sin(b.y * 0.05) * 0.5;
    });

    // Remove bubbles above liquid or too high
    bubblesRef.current = bubblesRef.current.filter(b => b.y > liquidY + 10 && b.y > -50);
    
    setBubbles([...bubblesRef.current]);
  };

  // --- 4. Main Game Loop ---
  const gameLoop = (time: number) => {
    const t = time * 0.002;
    const { ctx, gainClock, gainOther, gainBass, gainDrums, gainVocals } = audioRef.current;

    // --- Input Logic ---
    // Use slower speed for vocal control stage
    const currentGaugeSpeed = stateRef.current.vocalActive 
        ? CONFIG.vocalGaugeSpeed 
        : CONFIG.gaugeSpeed;
    
    if (stateRef.current.isLeaning) {
        stateRef.current.gauge += currentGaugeSpeed; // Increase
    } else {
        stateRef.current.gauge -= CONFIG.decayRate; // Decay
    }
    // Clamp Gauge 0-100
    if (stateRef.current.gauge < 0) stateRef.current.gauge = 0;
    if (stateRef.current.gauge > 100) stateRef.current.gauge = 100;

    // --- Audio Control Logic ---
    let visualLevel = 0; // 0.0 ~ 1.0

    // Only control audio if context is ready
    if (ctx && gainClock) {
        if (stateRef.current.isLooping) {
            // [Stage 1] Loop Mode
            // Trigger Transition
            if (stateRef.current.gauge >= 100) {
                releaseLoop();
            }
            
            // Volume = Gauge / 100
            const vol = stateRef.current.gauge / 100;
            gainClock.gain.setTargetAtTime(vol, ctx.currentTime, 0.05);
            
            visualLevel = vol;
        } 
        else if (!stateRef.current.vocalActive) {
            // [Transition] Waiting for 17s
            // Clock is full volume
            gainClock.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05);
            
            // Visual stays full to show "Connection held"
            visualLevel = 1.0; 
            // Or maybe pulse slightly?
            visualLevel = 0.95 + Math.sin(time * 0.005) * 0.05;
        }
        else {
            // [Stage 2] Music Control Mode
            // Clock and Others stay full
            if (gainClock) gainClock.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05);
            if (gainOther) gainOther.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05);
            
            const gauge = stateRef.current.gauge;
            let bassVol = 0;
            let drumsVol = 0;
            let vocalsVol = 0;
            
            // 0~20%: bass
            if (gauge > 0 && gauge <= 20) {
                bassVol = gauge / 20; // 0~1
            } else if (gauge > 20) {
                bassVol = 1.0;
            }
            
            // 20~40%: drums
            if (gauge > 20 && gauge <= 40) {
                drumsVol = (gauge - 20) / 20; // 0~1
            } else if (gauge > 40) {
                drumsVol = 1.0;
            }
            
            // 40~100%: vocals
            if (gauge > 40 && gauge <= 100) {
                vocalsVol = (gauge - 40) / 60; // 0~1
            }
            
            if (gainBass) gainBass.gain.setTargetAtTime(bassVol, ctx.currentTime, 0.05);
            if (gainDrums) gainDrums.gain.setTargetAtTime(drumsVol, ctx.currentTime, 0.05);
            if (gainVocals) gainVocals.gain.setTargetAtTime(vocalsVol, ctx.currentTime, 0.05);

            // Visual level은 전체 게이지 비율 사용
            visualLevel = gauge / 100;
        }
    } else {
        // Audio not ready yet, just show visual gauge
        visualLevel = stateRef.current.gauge / 100;
    }

    // --- Visual Update ---
    // Smooth visual transition
    stateRef.current.visualGauge += (visualLevel - stateRef.current.visualGauge) * 0.1;
    const smoothVisual = stateRef.current.visualGauge;

    if (liquidGroupRef.current) {
        const maxY = 300;
        const currentY = maxY - (smoothVisual * 300);
        liquidGroupRef.current.setAttribute('transform', `translate(0, ${currentY})`);
    }

    // Waves
    if (pathRef1.current) pathRef1.current.setAttribute('d', createWavePath(t, 0, 8, 0.02));
    if (pathRef2.current) pathRef2.current.setAttribute('d', createWavePath(t, 2, 6, 0.025));
    if (pathRef3.current) pathRef3.current.setAttribute('d', createWavePath(t, 4, 10, 0.015));

    updateBubbles(smoothVisual);

    requestRef.current = requestAnimationFrame(gameLoop);
  };

  // --- Start game loop on mount ---
  useEffect(() => {
    // Start the game loop immediately so gauge works even before audio is ready
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    requestRef.current = requestAnimationFrame(gameLoop);
    
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  // --- Event Listeners ---
  useEffect(() => {
    const handleDown = (e: KeyboardEvent) => {
        if (CONFIG.inputKeys.includes(e.key)) {
            e.preventDefault();
            setIsLeaning(true);
            stateRef.current.isLeaning = true;
        }
    };
    const handleUp = (e: KeyboardEvent) => {
        if (CONFIG.inputKeys.includes(e.key)) {
            e.preventDefault();
            setIsLeaning(false);
            stateRef.current.isLeaning = false;
        }
    };
    const preventScroll = (e: KeyboardEvent) => {
        if (e.key === ' ') e.preventDefault();
    };

    window.addEventListener('keydown', handleDown);
    window.addEventListener('keyup', handleUp);
    window.addEventListener('keydown', preventScroll);

    return () => {
        window.removeEventListener('keydown', handleDown);
        window.removeEventListener('keyup', handleUp);
        window.removeEventListener('keydown', preventScroll);
        // Only close AudioContext if it exists and is not already closed
        if (audioRef.current.ctx && audioRef.current.ctx.state !== 'closed') {
            audioRef.current.ctx.close().catch(err => {
                // Ignore errors if context is already closing/closed
                console.warn('Error closing AudioContext:', err);
            });
        }
    };
  }, []); // Remove isLeaning dependency to avoid re-binding

  return (
    <div className="app-container">
      
      <div className={`input-indicator ${isLeaning ? 'active' : ''}`}></div>

      <div className={`clock-container ${isLeaning ? 'leaning-active' : ''} ${stage === 2 ? 'vocal-mode' : ''}`}>
        <svg width="300" height="300" viewBox="0 0 300 300">
          <defs>
            <clipPath id="circle-clip">
              <circle cx="150" cy="150" r="148" />
            </clipPath>
          </defs>

          <circle className="circle-bg" cx="150" cy="150" r="148"></circle>

          <g clipPath="url(#circle-clip)">
            <g id="liquid-group" ref={liquidGroupRef} transform="translate(0, 300)">
              <path ref={pathRef3} className="liquid-layer layer-3" />
              <path ref={pathRef2} className="liquid-layer layer-2" />
              <path ref={pathRef1} className="liquid-layer layer-1" />
            </g>

            {bubbles.map(b => (
              <circle
                key={b.id}
                cx={b.x}
                cy={b.y}
                r={b.r}
                fill="#fff"
                opacity={b.opacity}
                style={{ mixBlendMode: 'overlay' }}
              />
            ))}
          </g>
        </svg>
      </div>

      <div className="controls-stack">
        <div className="status-text">{statusText}</div>
        
        {!isReady && (
            <button className="btn-start" onClick={initAudio} disabled={isLoading}>
                {isLoading ? "LOADING..." : "CONNECT AUDIO"}
            </button>
        )}

        {isReady && (
          <div className="playback-controls">
            {!isPaused ? (
              <button className="btn-control" onClick={handlePause}>
                PAUSE
              </button>
            ) : (
              <button className="btn-control" onClick={handlePlay}>
                PLAY
              </button>
            )}
            <button className="btn-control" onClick={handleStop}>
              STOP
            </button>
          </div>
        )}
      </div>

      {errorMessage && <div className="error-msg">{errorMessage}</div>}

      {/* Music Selection - Bottom Right */}
      {isReady && (
        <div className="music-selector">
          <div className="music-list">
            {CONFIG.musicFolders.map((folder) => (
              <div
                key={folder}
                className={`music-item ${selectedMusic === folder ? 'active' : ''}`}
                onClick={() => setSelectedMusic(folder)}
              >
                {folder}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;