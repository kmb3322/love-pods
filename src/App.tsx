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
  const [, setStatusText] = useState("DISCONNECTED");
  const [isLeaning, setIsLeaning] = useState(false);
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [, setErrorMessage] = useState("");

  // 🟢 동적 음악 목록 상태 추가
  const [musicList, setMusicList] = useState<string[]>([]);
  const [selectedMusic, setSelectedMusic] = useState<string>(""); 
  const selectedMusicRef = useRef<string>(""); // 🟢 ref로도 저장하여 동기 접근
  const [isPaused, setIsPaused] = useState(false);
  const [pauseAnimFlip, setPauseAnimFlip] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [, setLoadingProgress] = useState({ current: 0, total: 0 });

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
  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const bgActivatedRef = useRef(false);
  const bgDarkRef = useRef<HTMLDivElement>(null);
  const stage2StartRef = useRef<number | null>(null);
  const transitionStartRef = useRef<number | null>(null); // stage1→stage2 전환 시작 시점
  const lastLeanRef = useRef(performance.now());
  const lastInteractionRef = useRef(performance.now());
  const resetTriggeredRef = useRef(false);
  const autoPauseRef = useRef(false); // 자동 정지 상태 (스페이스로 해제 가능)
  const manualPauseRef = useRef(false); // 수동 정지 상태 (클릭으로만 해제 가능)
  const inactivityTimerRef = useRef<number | null>(null);
  const isPausedRef = useRef(false); // isPaused의 ref 버전 (이벤트 핸들러용)
  const stageRef = useRef<0 | 1 | 2>(0); // stage의 ref 버전 (이벤트 핸들러용)
  const isLoadingRef = useRef(false); // isLoading의 ref 버전 (이벤트 핸들러용)
  
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

    // 모바일에서 비디오 재생 시작 (사용자 인터랙션 필요)
    if (bgVideoRef.current) {
      bgVideoRef.current.play().catch(() => {});
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
        const nowMs = performance.now();
        lastInteractionRef.current = nowMs;
        lastLeanRef.current = nowMs;
        stage2StartRef.current = nowMs;
        markInteraction();
    }, delay * 1000);
  };

  const releaseLoop = () => {
    const { ctx, clockSrc, startTime } = audioRef.current;
    if (!ctx || !clockSrc) return;

    clockSrc.loop = false;
    stateRef.current.isLooping = false;
    bgActivatedRef.current = true; // enable background video from this point
    transitionStartRef.current = performance.now(); // 전환 구간 시작 시점 기록
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

  const finishResetToInitial = () => {
    const { ctx } = audioRef.current;
    try { ctx?.close(); } catch (e) { console.error(e); }
    [audioRef.current.clockSrc, audioRef.current.otherSrc, audioRef.current.bassSrc, audioRef.current.drumsSrc, audioRef.current.vocalsSrc].forEach(src => {
      try { src?.stop(); } catch {}
    });
    audioRef.current = { 
      ctx: null, clockSrc: null, otherSrc: null, bassSrc: null, drumsSrc: null, vocalsSrc: null,
      gainClock: null, gainOther: null, gainBass: null, gainDrums: null, gainVocals: null, startTime: 0 
    };
    stateRef.current.isLooping = true;
    stateRef.current.vocalActive = false;
    stateRef.current.gauge = 0;
    stateRef.current.visualGauge = 0;
    bgActivatedRef.current = false;
    transitionStartRef.current = null;
    resetTriggeredRef.current = false;
    autoPauseRef.current = false;
    manualPauseRef.current = false;
    clearInactivityTimer();
    setIsResetting(false);
    setIsReady(false);
    setStage(0);
    setIsPaused(false);
    setIsLoading(false);
    setStatusText("DISCONNECTED");
  };

  const startResetToInitial = () => {
    if (resetTriggeredRef.current) return;
    resetTriggeredRef.current = true;
    setIsResetting(true);
  };

  const clearInactivityTimer = () => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  };

  const markInteraction = () => {
    const now = performance.now();
    lastInteractionRef.current = now;
    if (stateRef.current.vocalActive && !isPaused && !isResetting && !resetTriggeredRef.current) {
      clearInactivityTimer();
      inactivityTimerRef.current = window.setTimeout(() => {
        triggerAutoPause();
      }, 15000);
    }
  };

  const triggerAutoPause = () => {
    if (autoPauseRef.current || manualPauseRef.current) return;
    clearInactivityTimer();
    const { ctx, gainClock, gainOther, gainBass, gainDrums, gainVocals } = audioRef.current;
    if (ctx && ctx.state === 'running') {
      const now = ctx.currentTime;
      const fade = 1.2;
      [gainClock, gainOther, gainBass, gainDrums, gainVocals].forEach(g => {
        if (!g) return;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, now + fade);
      });
      setTimeout(async () => {
        if (ctx.state === 'running') {
          autoPauseRef.current = true;
          manualPauseRef.current = false;
          await ctx.suspend();
          setIsPaused(true);
          setPauseAnimFlip(prev => !prev);
          lastInteractionRef.current = performance.now();
          setStatusText("PAUSED (AUTO)");
        }
      }, fade * 1000 + 60);
    }
  };

  const restoreGainsAfterResume = () => {
    const { ctx, gainClock, gainOther, gainBass, gainDrums, gainVocals } = audioRef.current;
    if (!ctx) return;
    const gauge = stateRef.current.gauge;

    if (stateRef.current.vocalActive) {
      gainClock?.gain.setValueAtTime(1.0, ctx.currentTime);
      gainOther?.gain.setValueAtTime(1.0, ctx.currentTime);

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
      gainBass?.gain.setValueAtTime(bassVol, ctx.currentTime);
      gainDrums?.gain.setValueAtTime(drumVol, ctx.currentTime);
      gainVocals?.gain.setValueAtTime(vocalVol, ctx.currentTime);
    } else if (!stateRef.current.isLooping) {
      gainClock?.gain.setValueAtTime(1.0, ctx.currentTime);
    } else {
      gainClock?.gain.setValueAtTime(gauge / 100, ctx.currentTime);
    }
  };

  // --- Pause / Resume ---
  // 수동 정지 (클릭으로만 해제 가능)
  const handleManualPause = async () => {
    clearInactivityTimer();
    const { ctx } = audioRef.current;
    if (!ctx) return;

    if (ctx.state === 'running') {
      manualPauseRef.current = true;
      autoPauseRef.current = false;
      await ctx.suspend();
      setIsPaused(true);
      setPauseAnimFlip(prev => !prev);
      lastInteractionRef.current = performance.now();
      setStatusText("PAUSED");
    } else if (ctx.state === 'suspended') {
      // 수동 정지 해제 (클릭으로만)
      manualPauseRef.current = false;
      autoPauseRef.current = false;
      await ctx.resume();
      setIsPaused(false);
      setPauseAnimFlip(prev => !prev);
      const now = performance.now();
      lastInteractionRef.current = now;
      lastLeanRef.current = now;
      restoreGainsAfterResume();
      if (stateRef.current.vocalActive) {
        setStatusText("MUSIC ACTIVE");
        // 타이머 직접 재설정 (isPaused state가 비동기로 업데이트되므로)
        clearInactivityTimer();
        inactivityTimerRef.current = window.setTimeout(() => {
          triggerAutoPause();
        }, 15000);
      } else if (!stateRef.current.isLooping) {
        setStatusText("SYNC COMPLETE...");
      } else {
        setStatusText("SYNC TIME (HOLD SPACE)");
      }
    }
  };

  // 자동 정지에서 스페이스로 재개
  const resumeFromAutoPause = async () => {
    if (!autoPauseRef.current) return; // 자동 정지 상태가 아니면 무시
    
    clearInactivityTimer();
    const { ctx } = audioRef.current;
    if (!ctx || ctx.state !== 'suspended') return;

    autoPauseRef.current = false;
    manualPauseRef.current = false;
    await ctx.resume();
    setIsPaused(false);
    setPauseAnimFlip(prev => !prev);
    const now = performance.now();
    lastInteractionRef.current = now;
    lastLeanRef.current = now;
    restoreGainsAfterResume();
    if (stateRef.current.vocalActive) {
      setStatusText("MUSIC ACTIVE");
      // 타이머 재설정: 직접 타이머 설정
      clearInactivityTimer();
      inactivityTimerRef.current = window.setTimeout(() => {
        triggerAutoPause();
      }, 15000);
    } else if (!stateRef.current.isLooping) {
      setStatusText("SYNC COMPLETE...");
    } else {
      setStatusText("SYNC TIME (HOLD SPACE)");
    }
  };

  // --- Main Loop ---
  const gameLoop = (time: number) => {
    const t = time * 0.002;
    const { ctx, gainClock, gainBass, gainDrums, gainVocals } = audioRef.current;
    const nowMs = performance.now();

    // Auto-pause on inactivity in stage 2+ (timer driven via markInteraction)
    const isStage2OrMore = stage >= 2 || stateRef.current.vocalActive;
    if (!isPaused && isStage2OrMore && !isResetting && !resetTriggeredRef.current && audioRef.current.ctx?.state === 'running') {
      // ensure timer is armed if not already
      if (!inactivityTimerRef.current) {
        inactivityTimerRef.current = window.setTimeout(() => {
          triggerAutoPause();
        }, 15000);
      }
    }

    // If paused, skip gauge/visual updates but keep the loop alive
    if (isPaused) {
      requestRef.current = requestAnimationFrame(gameLoop);
      return;
    }

    // Input Logic
    const currentGaugeSpeed = stateRef.current.vocalActive ? CONFIG.vocalGaugeSpeed : CONFIG.gaugeSpeed;

    if (stateRef.current.isLeaning) {
        stateRef.current.gauge += currentGaugeSpeed;
    } else if (isResetting) {
        stateRef.current.gauge -= 2.5; // faster decay during reset
    } else {
        stateRef.current.gauge -= CONFIG.decayRate;
    }

    // Stage 2 inactivity reset (15s no leaning)
    if (stateRef.current.vocalActive) {
        if (stateRef.current.isLeaning) {
            lastLeanRef.current = nowMs;
            lastInteractionRef.current = nowMs;
        } else if (!isResetting && !resetTriggeredRef.current && nowMs - lastLeanRef.current > 15000) {
            startResetToInitial();
        }
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

    // Background video opacity tied to progress after first loop release
    const bgVideo = bgVideoRef.current;
    const shouldShowBg = (bgActivatedRef.current || stateRef.current.vocalActive) && !isResetting;
    
    let targetOpacity = 0;
    if (shouldShowBg) {
      if (stateRef.current.vocalActive) {
        // stage2: 0.3 ~ 1.0 범위 (게이지에 따라)
        const baseOpacity = 0.3;
        targetOpacity = Math.min(Math.max(baseOpacity + smoothVisual * (1 - baseOpacity), baseOpacity), 1);
      } else {
        // 전환 구간: 0 → 0.3으로 천천히 증가 (CONFIG.vocalStartTime 동안)
        const transitionDuration = CONFIG.vocalStartTime * 1000; // 17초를 ms로
        const elapsed = transitionStartRef.current ? nowMs - transitionStartRef.current : 0;
        const progress = Math.min(elapsed / transitionDuration, 1);
        targetOpacity = 0.3 * progress;
      }
    }
    
    if (bgVideo) {
      bgVideo.style.opacity = `${targetOpacity}`;
      if (shouldShowBg && bgVideo.paused) {
        bgVideo.play().catch(() => {});
      }
    }

    // Darken overlay with gauge in stage 2
    const darkLayer = bgDarkRef.current;
    if (darkLayer) {
      const darkOpacity = stateRef.current.vocalActive
        ? Math.min(Math.max(smoothVisual * 0.9, 0), 0.9)
        : 0;
      darkLayer.style.opacity = `${darkOpacity}`;
    }

    if (liquidGroupRef.current) {
        const maxY = 300;
        const currentY = maxY - (smoothVisual * 300);
        liquidGroupRef.current.setAttribute('transform', `translate(0, ${currentY})`);
    }
    if (pathRef1.current) pathRef1.current.setAttribute('d', createWavePath(t, 0, 8, 0.02));
    if (pathRef2.current) pathRef2.current.setAttribute('d', createWavePath(t, 2, 6, 0.025));
    if (pathRef3.current) pathRef3.current.setAttribute('d', createWavePath(t, 4, 10, 0.015));

    if (isResetting && stateRef.current.gauge === 0 && smoothVisual < 0.02) {
      finishResetToInitial();
      return;
    }

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
    if (stateRef.current.vocalActive) {
      bubblesRef.current = [];
      setBubbles([]);
      return;
    }
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

  // ref 동기화 (이벤트 핸들러에서 최신 상태 참조용)
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    const handleDown = (e: KeyboardEvent) => {
        if (CONFIG.inputKeys.includes(e.key)) {
            // 자동 정지 상태에서만 스페이스로 재개 가능 (수동 정지는 클릭으로만)
            if (isPausedRef.current && (stageRef.current >= 2 || stateRef.current.vocalActive) && !isLoadingRef.current) {
                if (autoPauseRef.current) {
                    // 자동 정지: 스페이스로 재개
                    resumeFromAutoPause();
                }
                // 수동 정지(manualPauseRef.current === true)인 경우는 무시 (클릭으로만 해제)
                return;
            }
            stateRef.current.isLeaning = true;
            setIsLeaning(true);
            const now = performance.now();
            lastLeanRef.current = now;
            lastInteractionRef.current = now;
            markInteraction();
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

  const handleGaugeClick = () => {
    if (!isReady && !isLoading) {
      initAudio();
    } else if (isReady && (stage >= 2 || stateRef.current.vocalActive)) {
      lastInteractionRef.current = performance.now();
      // 수동 정지/재개 (클릭으로만 토글)
      handleManualPause();
    }
  };

  return (
    <div className={`app-container ${stage === 2 ? 'stage2' : ''}`}>
      <video
        className={`bg-video ${bgActivatedRef.current ? 'visible' : ''}`}
        ref={bgVideoRef}
        src="/bright.mp4"
        autoPlay
        muted
        loop
        playsInline
        // @ts-ignore - webkit prefix for older iOS
        webkit-playsinline="true"
        preload="auto"
      />
      <div className="bg-darken" ref={bgDarkRef}></div>
      <div className={`input-indicator ${isLeaning ? 'active' : ''}`}></div>
      <div 
        className={`clock-container ${isLeaning ? 'leaning-active' : ''} ${stage === 2 ? 'vocal-mode' : ''} ${isReady ? 'active' : ''} ${!isReady ? 'initial' : ''} ${isLoading ? 'loading' : ''} ${(pauseAnimFlip ? 'pause-anim-a' : 'pause-anim-b')} ${isPaused ? 'paused' : ''}`}
        onClick={handleGaugeClick}
      >
        <svg width="300" height="300" viewBox="0 0 300 300">
          <defs>
            <clipPath id="circle-clip"><circle cx="150" cy="150" r="148" /></clipPath>
            <linearGradient id="rainbow-grad-1" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#e88fb3">
                <animate attributeName="stop-color" values="#e88fb3;#c38fff;#7ab8ff;#e88fd3;#e88fb3" dur="16s" repeatCount="indefinite" />
              </stop>
              <stop offset="100%" stopColor="#7ab8ff">
                <animate attributeName="stop-color" values="#7ab8ff;#8fc2ff;#e88fd3;#e88fb3;#7ab8ff" dur="16s" repeatCount="indefinite" />
              </stop>
            </linearGradient>
            <linearGradient id="rainbow-grad-2" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#e88fd3">
                <animate attributeName="stop-color" values="#e88fd3;#e88fb3;#c38fff;#7ab8ff;#e88fd3" dur="18s" repeatCount="indefinite" />
              </stop>
              <stop offset="100%" stopColor="#c38fff">
                <animate attributeName="stop-color" values="#c38fff;#8fc2ff;#7ab8ff;#e88fb3;#e88fd3;#c38fff" dur="18s" repeatCount="indefinite" />
              </stop>
            </linearGradient>
            <linearGradient id="rainbow-grad-3" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#8fc2ff" stopOpacity="0.65">
                <animate attributeName="stop-color" values="#8fc2ff;#c38fff;#e88fd3;#e88fb3;#8fc2ff" dur="20s" repeatCount="indefinite" />
              </stop>
              <stop offset="100%" stopColor="#e88fb3" stopOpacity="0.5">
                <animate attributeName="stop-color" values="#e88fb3;#e88fd3;#7ab8ff;#8fc2ff;#e88fb3" dur="20s" repeatCount="indefinite" />
              </stop>
            </linearGradient>
          </defs>
          <circle className="circle-bg" cx="150" cy="150" r="148"></circle>
          <g clipPath="url(#circle-clip)">
            <g id="liquid-group" ref={liquidGroupRef} transform="translate(0, 300)">
              <path ref={pathRef3} className="liquid-layer layer-3" />
              <path ref={pathRef2} className="liquid-layer layer-2" />
              <path ref={pathRef1} className="liquid-layer layer-1" />
            </g>
            {stage !== 2 && bubbles.map(b => (
              <circle 
                key={b.id} 
                cx={b.x} 
                cy={b.y} 
                r={b.r} 
                fill="#fff" 
                opacity={b.opacity} 
                style={{
                  mixBlendMode: 'overlay',
                  transition: 'fill 1.5s ease-in-out'
                }}
              />
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

export default App;