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
  vocalStartTime: 17.0,  // 2단계: 음악 시작 시간
  gaugeSpeed: 0.15,      // 게이지 속도
  vocalGaugeSpeed: 0.15, // 보컬 컨트롤 속도
  decayRate: 0.5,        // 감소 속도
  fadeOutTime: 10.0,     // 페이드아웃 시간
  inputKeys: [' ', 'Enter'],
  // 🔴 musicFolders 삭제됨
};

function App() {
  // --- UI States ---
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState("DISCONNECTED");
  const [isLeaning, setIsLeaning] = useState(false);
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [errorMessage, setErrorMessage] = useState("");

  // 🟢 동적 음악 목록 상태 추가
  const [musicList, setMusicList] = useState<string[]>([]);
  const [selectedMusic, setSelectedMusic] = useState<string>(""); 
  const selectedMusicRef = useRef<string>(""); // 🟢 ref로도 저장하여 동기 접근
  const [isPaused, setIsPaused] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });

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
    startTime: number;
  }>({
    ctx: null, clockSrc: null, otherSrc: null, bassSrc: null, drumsSrc: null, vocalsSrc: null,
    gainClock: null, gainOther: null, gainBass: null, gainDrums: null, gainVocals: null, startTime: 0
  });

  const buffersRef = useRef<{ clock: AudioBuffer | null }>({
    clock: null
  });

  // musicBuffers는 ref로만 관리 (state는 제거하여 불필요한 리렌더링 방지)

  // 🟢 ref로도 저장하여 동기적으로 접근 가능하도록
  const musicBuffersRef = useRef<{
    [key: string]: {
      other: AudioBuffer | null;
      bass: AudioBuffer | null;
      drums: AudioBuffer | null;
      vocals: AudioBuffer | null;
    }
  }>({});

  const stateRef = useRef({
    gauge: 0,
    visualGauge: 0,
    isLooping: true,
    vocalActive: false,
    isLeaning: false,
  });

  const requestRef = useRef<number | undefined>(undefined);
  
  // Visual Refs
  const pathRef1 = useRef<SVGPathElement>(null);
  const pathRef2 = useRef<SVGPathElement>(null);
  const pathRef3 = useRef<SVGPathElement>(null);
  const liquidGroupRef = useRef<SVGGElement>(null);
  
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const bubbleIdRef = useRef(0);
  const bubblesRef = useRef<Bubble[]>([]);

  // 🟢 앱 시작 시 music_list.json 로드
  useEffect(() => {
    fetch('/music_list.json')
      .then(res => res.json())
      .then(data => {
        setMusicList(data);
        if (data.length > 0) {
          setSelectedMusic(data[0]);
          selectedMusicRef.current = data[0];
        }
      })
      .catch(err => {
        console.error("Failed to load music list:", err);
        setErrorMessage("Music list load failed. Check public/music_list.json");
      });
  }, []);

  // --- Audio Loading ---
  const loadFile = async (ctx: AudioContext, url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}`);
    return await ctx.decodeAudioData(await res.arrayBuffer());
  };

  const loadMusicFolder = async (ctx: AudioContext, folderName: string) => {
    const extensions = ['.wav', '.flac', '.mp3'];

    // Helper to try loading with different extensions (병렬 시도)
    const tryLoad = async (filename: string) => {
      // 모든 확장자를 병렬로 시도하여 가장 빠른 것 사용
      const promises = extensions.map(ext => 
        loadFile(ctx, `/${folderName}/${filename}${ext}`).catch(() => null)
      );
      const results = await Promise.all(promises);
      return results.find(r => r !== null) || null;
    };

    // 모든 트랙을 병렬로 로드
    const [other, bass, drums, vocals] = await Promise.all([
      tryLoad('other'),
      tryLoad('bass'),
      tryLoad('drums'),
      tryLoad('vocals')
    ]);

    return { other, bass, drums, vocals };
  };

  const initAudio = async () => {
    if (isLoading) return;
    // 이미 ready 상태면 재시작하지 않음 (정지 후 다시 시작하는 경우는 허용)
    const currentSelected = selectedMusicRef.current || selectedMusic;
    if (!currentSelected) {
      setErrorMessage("No music selected");
      return;
    }

    setIsLoading(true);
    try {
      setStatusText("LOADING...");
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      
      // 기존 context가 있으면 닫고 새로 생성 (clock을 처음부터 시작하기 위해)
      if (audioRef.current.ctx) {
        try {
          await audioRef.current.ctx.close();
        } catch (e) {
          console.error("Error closing audio context:", e);
        }
      }
      
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();

      // 1. Clock 로드
      setStatusText("LOADING CLOCK...");
      const clockBuf = await loadFile(ctx, '/onlyclock.wav');
      buffersRef.current = { clock: clockBuf };

      // 2. 모든 음악을 효율적으로 로드 (우선순위 기반 병렬 로딩)
      const totalMusic = musicList.length;
      setLoadingProgress({ current: 0, total: totalMusic });
      
      // 선택된 음악을 먼저 로드 (우선순위)
      setStatusText(`LOADING ${currentSelected}...`);
      const selectedBuffers = await loadMusicFolder(ctx, currentSelected);
      musicBuffersRef.current[currentSelected] = selectedBuffers;
      setLoadingProgress({ current: 1, total: totalMusic });

      // Node Setup (선택된 음악이 로드되면 바로 시작 가능)
      const gainClock = ctx.createGain();
      const gainOther = ctx.createGain();
      const gainBass = ctx.createGain();
      const gainDrums = ctx.createGain();
      const gainVocals = ctx.createGain();
      
      gainClock.gain.value = 0;
      gainOther.gain.value = 0;
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

      // 선택된 음악이 로드되었으므로 바로 시작
      startMusic(ctx, clockBuf);

      // 3. 나머지 음악들을 백그라운드에서 병렬로 로드 (에러가 있어도 계속 진행)
      const remainingMusic = musicList.filter(folder => folder !== currentSelected);
      if (remainingMusic.length > 0) {
        Promise.allSettled(
          remainingMusic.map(async (folder, index) => {
            try {
              const buffers = await loadMusicFolder(ctx, folder);
              musicBuffersRef.current[folder] = buffers;
              setLoadingProgress({ current: 1 + index + 1, total: totalMusic });
            } catch (e) {
              console.error(`Failed to load ${folder}:`, e);
              // 에러가 있어도 계속 진행
            }
          })
        ).then(() => {
          setLoadingProgress({ current: totalMusic, total: totalMusic });
        });
      }

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

    // 기존 clock source가 있으면 정지
    if (audioRef.current.clockSrc) {
      try {
        audioRef.current.clockSrc.stop();
      } catch (e) {
        // 이미 정지된 경우 무시
      }
    }

    const sampleRate = clockBuf.sampleRate;
    const loopStartSample = 0;
    const loopEndSample = Math.floor(CONFIG.loopEndTime * sampleRate);
    
    // 새로운 clock source 생성 (처음부터 시작)
    const clockSrc = ctx.createBufferSource();
    clockSrc.buffer = clockBuf;
    clockSrc.loop = true;
    clockSrc.loopStart = loopStartSample / sampleRate; // 0초부터 시작
    clockSrc.loopEnd = loopEndSample / sampleRate; // 7초까지 반복
    clockSrc.connect(gainClock);

    // 현재 시간을 기준으로 처음부터 시작
    const now = ctx.currentTime;
    clockSrc.start(now);
    
    audioRef.current.clockSrc = clockSrc;
    audioRef.current.startTime = now; // 시작 시간을 현재 시간으로 설정 (처음부터 시작)

    setIsReady(true);
    setStage(1);
    setStatusText("SYNC TIME (HOLD SPACE)");

    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    requestRef.current = requestAnimationFrame(gameLoop);
  };

  const scheduleMusicAt17s = (ctx: AudioContext, musicStartAt: number) => {
    const { gainOther, gainBass, gainDrums, gainVocals } = audioRef.current;
    if (!gainOther || !gainBass || !gainDrums || !gainVocals) return;

    // 🟢 ref에서 직접 가져와서 최신 값 보장
    const currentSelected = selectedMusicRef.current || selectedMusic;
    const currentMusic = musicBuffersRef.current[currentSelected];
    if (!currentMusic || !currentMusic.other) {
      console.error(`Music buffers not loaded for: ${currentSelected}`, currentMusic);
      setErrorMessage(`Failed to load music: ${currentSelected}`);
      return;
    }

    const createSrc = (buf: AudioBuffer | null, gain: GainNode) => {
        if(!buf) return null;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(gain);
        src.start(musicStartAt);
        return src;
    };

    audioRef.current.otherSrc = createSrc(currentMusic.other, gainOther);
    audioRef.current.bassSrc = createSrc(currentMusic.bass, gainBass);
    audioRef.current.drumsSrc = createSrc(currentMusic.drums, gainDrums);
    audioRef.current.vocalsSrc = createSrc(currentMusic.vocals, gainVocals);

    // Other(반주) 바로 켜기
    gainOther.gain.setValueAtTime(1.0, musicStartAt);

    const delay = Math.max(0, musicStartAt - ctx.currentTime);
    setTimeout(() => {
        stateRef.current.vocalActive = true;
        setStage(2);
        setStatusText("MUSIC ACTIVE");
        stateRef.current.gauge = 0;
    }, delay * 1000);
  };

  const releaseLoop = () => {
    const { ctx, clockSrc, startTime } = audioRef.current;
    if (!ctx || !clockSrc) return;

    clockSrc.loop = false;
    stateRef.current.isLooping = false;
    setStatusText("SYNC COMPLETE...");

    const now = ctx.currentTime;
    
    // 현재 loop의 시작 시간부터 경과 시간 계산
    const elapsed = now - startTime;
    
    // 현재 loop가 끝나는 시점 계산 (다음 loop 시작 시점)
    // loop는 0~7초 구간을 반복하므로, 현재 loop의 끝나는 시점을 계산
    const currentLoopEnd = startTime + (Math.floor(elapsed / CONFIG.loopEndTime) + 1) * CONFIG.loopEndTime;
    
    // 마지막 loop가 끝나고 다시 처음으로 돌아가는 시점을 0초로 설정
    const loopEndTime = currentLoopEnd;
    
    // 그 시점부터 17초 후에 음악 시작
    const musicStartTime = loopEndTime + CONFIG.vocalStartTime;
    
    scheduleMusicAt17s(ctx, musicStartTime);
  };

  // --- Pause / Resume ---
  const handlePause = async () => {
    const { ctx } = audioRef.current;
    if (!ctx) return;

    if (ctx.state === 'running') {
      await ctx.suspend();
      setIsPaused(true);
      setStatusText("PAUSED");
    } else if (ctx.state === 'suspended') {
      await ctx.resume();
      setIsPaused(false);
      if (stateRef.current.vocalActive) {
        setStatusText("MUSIC ACTIVE");
      } else if (!stateRef.current.isLooping) {
        setStatusText("SYNC COMPLETE...");
      } else {
        setStatusText("SYNC TIME (HOLD SPACE)");
      }
    }
  };

  // --- Stop to Initial Stage ---
  const handleStop = () => {
    const { ctx, gainClock, gainOther, gainBass, gainDrums, gainVocals } = audioRef.current;
    if (!ctx || !gainClock) return;

    const now = ctx.currentTime;
    const fade = CONFIG.fadeOutTime;

    // Fade out all gains
    [gainClock, gainOther, gainBass, gainDrums, gainVocals].forEach(g => {
        if(g) {
            g.gain.cancelScheduledValues(now);
            g.gain.setValueAtTime(g.gain.value, now);
            g.gain.linearRampToValueAtTime(0, now + fade);
        }
    });

    setTimeout(() => {
        // Stop all sources
        [audioRef.current.clockSrc, audioRef.current.otherSrc, audioRef.current.bassSrc, audioRef.current.drumsSrc, audioRef.current.vocalsSrc].forEach(src => {
            try { src?.stop(); } catch {}
        });

        // Close audio context
        ctx.close().catch(console.error);

        // Reset all state to initial stage
        stateRef.current.isLooping = true;
        stateRef.current.vocalActive = false;
        stateRef.current.gauge = 0;
        stateRef.current.visualGauge = 0;
        setIsReady(false);
        setStage(0);
        setStatusText("DISCONNECTED");
        setIsPaused(false);
        setIsLoading(false);
        
        // Clear audio refs
        audioRef.current = {
          ctx: null, clockSrc: null, otherSrc: null, bassSrc: null, drumsSrc: null, vocalsSrc: null,
          gainClock: null, gainOther: null, gainBass: null, gainDrums: null, gainVocals: null, startTime: 0
        };

    }, fade * 1000);
  };

  // --- Main Loop ---
  const gameLoop = (time: number) => {
    const t = time * 0.002;
    const { ctx, gainClock, gainBass, gainDrums, gainVocals } = audioRef.current;

    // Input Logic
    const currentGaugeSpeed = stateRef.current.vocalActive ? CONFIG.vocalGaugeSpeed : CONFIG.gaugeSpeed;
    if (stateRef.current.isLeaning) {
        stateRef.current.gauge += currentGaugeSpeed;
    } else {
        stateRef.current.gauge -= CONFIG.decayRate;
    }
    if (stateRef.current.gauge < 0) stateRef.current.gauge = 0;
    if (stateRef.current.gauge > 100) stateRef.current.gauge = 100;

    const gauge = stateRef.current.gauge;
    let visualLevel = 0;

    if (ctx && gainClock) {
        if (stateRef.current.isLooping) {
            if (gauge >= 100) releaseLoop();
            gainClock.gain.setTargetAtTime(gauge / 100, ctx.currentTime, 0.05);
            visualLevel = gauge / 100;
        } 
        else if (!stateRef.current.vocalActive) {
            gainClock.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05);
            visualLevel = 1.0; 
        } 
        else {
            gainClock.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05);
            
            let bassVol = 0, drumVol = 0, vocalVol = 0;
            if (gauge <= 20) bassVol = gauge / 20;
            else {
                bassVol = 1.0;
                if (gauge <= 40) drumVol = (gauge - 20) / 20;
                else {
                    drumVol = 1.0;
                    vocalVol = (gauge - 40) / 60;
                }
            }

            gainBass?.gain.setTargetAtTime(bassVol, ctx.currentTime, 0.05);
            gainDrums?.gain.setTargetAtTime(drumVol, ctx.currentTime, 0.05);
            gainVocals?.gain.setTargetAtTime(vocalVol, ctx.currentTime, 0.05);
            
            visualLevel = gauge / 100;
        }
    }

    stateRef.current.visualGauge += (visualLevel - stateRef.current.visualGauge) * 0.1;
    const smoothVisual = stateRef.current.visualGauge;

    if (liquidGroupRef.current) {
        const maxY = 300;
        const currentY = maxY - (smoothVisual * 300);
        liquidGroupRef.current.setAttribute('transform', `translate(0, ${currentY})`);
    }
    if (pathRef1.current) pathRef1.current.setAttribute('d', createWavePath(t, 0, 8, 0.02));
    if (pathRef2.current) pathRef2.current.setAttribute('d', createWavePath(t, 2, 6, 0.025));
    if (pathRef3.current) pathRef3.current.setAttribute('d', createWavePath(t, 4, 10, 0.015));

    updateBubbles(smoothVisual);
    requestRef.current = requestAnimationFrame(gameLoop);
  };

  const createWavePath = (time: number, offset: number, amp: number, freq: number) => {
    const width = 300;
    let d = `M0,0`;
    const points = [];
    for (let x = 0; x <= width; x += 20) {
      const y = Math.sin(x * freq + time + offset) * amp;
      points.push([x, y]);
    }
    d = `M0,${points[0][1]}`;
    points.forEach(p => d += ` L${p[0]},${p[1]}`);
    d += ` V350 H0 Z`;
    return d;
  };

  const updateBubbles = (level: number) => {
    if (Math.random() < 0.1 && (isLeaning || !stateRef.current.isLooping)) {
        const id = bubbleIdRef.current++;
        bubblesRef.current.push({
            id, x: 50 + Math.random() * 200, y: 300, r: 2 + Math.random() * 4,
            speed: 1 + Math.random() * 2, opacity: 0.5
        });
    }
    const limitY = 300 - (level * 300);
    bubblesRef.current.forEach(b => { b.y -= b.speed; b.x += Math.sin(b.y*0.1); });
    bubblesRef.current = bubblesRef.current.filter(b => b.y > limitY && b.y > -50);
    setBubbles([...bubblesRef.current]);
  };

  useEffect(() => {
    const handleDown = (e: KeyboardEvent) => {
        if (CONFIG.inputKeys.includes(e.key)) {
            stateRef.current.isLeaning = true;
            setIsLeaning(true);
        }
    };
    const handleUp = (e: KeyboardEvent) => {
        if (CONFIG.inputKeys.includes(e.key)) {
            stateRef.current.isLeaning = false;
            setIsLeaning(false);
        }
    };
    window.addEventListener('keydown', handleDown);
    window.addEventListener('keyup', handleUp);
    return () => {
        window.removeEventListener('keydown', handleDown);
        window.removeEventListener('keyup', handleUp);
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
        audioRef.current.ctx?.close();
    };
  }, []);

  return (
    <div className="app-container">
      <div className={`input-indicator ${isLeaning ? 'active' : ''}`}></div>
      <div className={`clock-container ${isLeaning ? 'leaning-active' : ''} ${stage === 2 ? 'vocal-mode' : ''}`}>
        <svg width="300" height="300" viewBox="0 0 300 300">
          <defs><clipPath id="circle-clip"><circle cx="150" cy="150" r="148" /></clipPath></defs>
          <circle className="circle-bg" cx="150" cy="150" r="148"></circle>
          <g clipPath="url(#circle-clip)">
            <g id="liquid-group" ref={liquidGroupRef} transform="translate(0, 300)">
              <path ref={pathRef3} className="liquid-layer layer-3" />
              <path ref={pathRef2} className="liquid-layer layer-2" />
              <path ref={pathRef1} className="liquid-layer layer-1" />
            </g>
            {bubbles.map(b => (
              <circle key={b.id} cx={b.x} cy={b.y} r={b.r} fill="#fff" opacity={b.opacity} style={{mixBlendMode:'overlay'}}/>
            ))}
          </g>
        </svg>
      </div>

      <div className="controls-stack">
        <div className="status-text">{statusText}</div>
        {isLoading && loadingProgress.total > 0 && (
          <div className="loading-progress">
            <div className="progress-bar">
              <div 
                className="progress-fill" 
                style={{ width: `${(loadingProgress.current / loadingProgress.total) * 100}%` }}
              ></div>
            </div>
            <div className="progress-text">
              {loadingProgress.current} / {loadingProgress.total}
            </div>
          </div>
        )}
        {!isReady ? (
            <button className="btn-start" onClick={initAudio} disabled={isLoading}>
                {isLoading ? "LOADING..." : "CONNECT AUDIO"}
            </button>
        ) : (
            <div className="control-buttons">
              <button className="icon-btn btn-pause" onClick={handlePause} title={isPaused ? "Resume" : "Pause"}>
                {isPaused ? (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="4" width="4" height="16"></rect>
                    <rect x="14" y="4" width="4" height="16"></rect>
                  </svg>
                )}
              </button>
              <button className="icon-btn btn-stop" onClick={handleStop} title="Stop">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="6" width="12" height="12"></rect>
                </svg>
              </button>
            </div>
        )}
      </div>

      {/* 🟢 Music List Selector - Stage 1, 2에서 표시 및 변경 가능 */}
      {isReady && (stage === 1 || stage === 2) && (
        <div className="music-selector">
          <div className="label">SELECTED TRACK</div>
          {musicList.map(m => (
            <div 
              key={m} 
              className={`music-item ${selectedMusic === m ? 'selected' : ''} ${!isLoading ? 'selectable' : ''} ${isLoading && selectedMusic !== m ? 'loading' : ''}`}
              onClick={async () => {
                  if(!isLoading) {
                    const newMusic = m;
                    if (newMusic === selectedMusic) return; // 같은 음악이면 무시
                    
                    // 새 음악이 로드되지 않았다면 먼저 로드 (이미 로드된 음악은 스킵)
                    if (!musicBuffersRef.current[newMusic]?.other) {
                      const { ctx } = audioRef.current;
                      if (ctx) {
                        setIsLoading(true);
                        setStatusText(`LOADING ${newMusic}...`);
                        try {
                          const buffers = await loadMusicFolder(ctx, newMusic);
                          musicBuffersRef.current[newMusic] = buffers;
                        } catch (e) {
                          console.error(`Failed to load music: ${newMusic}`, e);
                          setErrorMessage(`Failed to load music: ${newMusic}`);
                          setIsLoading(false);
                          return;
                        } finally {
                          setIsLoading(false);
                        }
                      }
                    }
                    
                    // 음악 변경
                    setSelectedMusic(newMusic);
                    selectedMusicRef.current = newMusic;
                    
                    // stage2에서는 stage 유지하고 노래만 변경
                    if (stage === 2) {
                      const { ctx, gainOther, gainBass, gainDrums, gainVocals } = audioRef.current;
                      if (ctx && gainOther && gainBass && gainDrums && gainVocals) {
                        const now = ctx.currentTime;
                        const fade = 1.0; // 빠른 전환
                        
                        // 기존 음악 트랙 fade out
                        [gainOther, gainBass, gainDrums, gainVocals].forEach(g => {
                          g.gain.cancelScheduledValues(now);
                          g.gain.setValueAtTime(g.gain.value, now);
                          g.gain.linearRampToValueAtTime(0, now + fade);
                        });
                        
                        setTimeout(() => {
                          // 기존 음악 소스 정지
                          [audioRef.current.otherSrc, audioRef.current.bassSrc, audioRef.current.drumsSrc, audioRef.current.vocalsSrc].forEach(src => {
                            try { src?.stop(); } catch {}
                          });
                          
                          // 새 음악으로 즉시 시작 (stage2 유지)
                          const currentSelected = selectedMusicRef.current || selectedMusic;
                          const currentMusic = musicBuffersRef.current[currentSelected];
                          if (currentMusic?.other) {
                            const createSrc = (buf: AudioBuffer | null, gain: GainNode) => {
                              if(!buf) return null;
                              const src = ctx.createBufferSource();
                              src.buffer = buf;
                              src.connect(gain);
                              src.start(ctx.currentTime);
                              return src;
                            };

                            audioRef.current.otherSrc = createSrc(currentMusic.other, gainOther);
                            audioRef.current.bassSrc = createSrc(currentMusic.bass, gainBass);
                            audioRef.current.drumsSrc = createSrc(currentMusic.drums, gainDrums);
                            audioRef.current.vocalsSrc = createSrc(currentMusic.vocals, gainVocals);

                            // Other(반주) 바로 켜기
                            gainOther.gain.setValueAtTime(1.0, ctx.currentTime);
                            
                            // 게이지 상태 유지 (초기화하지 않음)
                            // stage2 상태 유지
                          }
                        }, fade * 1000);
                      }
                    } else {
                      // stage1에서는 재시작
                      const { ctx, gainClock, gainOther, gainBass, gainDrums, gainVocals } = audioRef.current;
                      if (ctx && gainClock) {
                        const now = ctx.currentTime;
                        const fade = CONFIG.fadeOutTime;
                        
                        // Fade out all gains
                        [gainClock, gainOther, gainBass, gainDrums, gainVocals].forEach(g => {
                          if(g) {
                            g.gain.cancelScheduledValues(now);
                            g.gain.setValueAtTime(g.gain.value, now);
                            g.gain.linearRampToValueAtTime(0, now + fade);
                          }
                        });
                        
                        setTimeout(() => {
                          // Stop all sources
                          [audioRef.current.clockSrc, audioRef.current.otherSrc, audioRef.current.bassSrc, audioRef.current.drumsSrc, audioRef.current.vocalsSrc].forEach(src => {
                            try { src?.stop(); } catch {}
                          });
                          
                          // 새 음악으로 재시작 - startMusic 함수 사용하여 clock을 제대로 시작
                          const { clock } = buffersRef.current;
                          if (clock) {
                            // startMusic 함수를 사용하여 clock을 처음부터 제대로 시작
                            startMusic(ctx, clock);
                          }
                        }, fade * 1000);
                      }
                    }
                  }
              }}
            >
              {m}
            </div>
          ))}
        </div>
      )}

      {errorMessage && <div className="error-msg">{errorMessage}</div>}
    </div>
  );
}

export default App;