/* ============================================
   Study Invaders: Global Retro Audio Engine
   ============================================ */

class RetroAudioEngine {
  constructor() {
    // Background Music
    this.bgm = new Audio('assets/audio/mega_hyper_ultrastorm.mp3');
    this.bgm.loop = true;
    this.bgm.volume = 0.10; // Lowered background volume to 10% (comfortable retro background level)

    // Sound Effects Paths
    this.explosionSrc = 'assets/audio/explosion.wav';
    this.laserSrc = 'assets/audio/laserShoot.wav';
    this.powerUpSrc = 'assets/audio/powerUp.wav';

    // State
    this.isMuted = localStorage.getItem('si_muted') === 'true';
    this.initialized = false;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;

    // Handle Browser Autoplay Policy: start music on first user click/keypress
    const startAudio = () => {
      if (!this.isMuted && this.bgm.paused) {
        this.bgm.play().catch(() => {});
      }
      window.removeEventListener('click', startAudio);
      window.removeEventListener('keydown', startAudio);
    };

    window.addEventListener('click', startAudio);
    window.addEventListener('keydown', startAudio);
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    localStorage.setItem('si_muted', this.isMuted);

    if (this.isMuted) {
      this.bgm.pause();
    } else {
      this.bgm.play().catch(() => {});
    }
    return this.isMuted;
  }

  playSFX(src, volume = 0.15) {
    if (this.isMuted) return;
    const sfx = new Audio(src);
    sfx.volume = volume;
    sfx.play().catch(() => {});
  }

  playExplosion() {
    this.playSFX(this.explosionSrc, 0.15); // Lowered explosion SFX to 15%
  }

  playLaser() {
    this.playSFX(this.laserSrc, 0.10); // Lowered laser SFX to 10%
  }

  playPowerUp() {
    this.playSFX(this.powerUpSrc, 0.15); // Lowered power-up SFX to 15%
  }
}

// Global Audio Engine Instance
const audioEngine = new RetroAudioEngine();
audioEngine.init();
