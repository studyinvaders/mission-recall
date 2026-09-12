/* Endless downward-scrolling pixel starfield, drawn on <canvas id="starfield">.
   Include this on every page after the canvas element exists. */
(function(){
  const canvas = document.getElementById('starfield');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');

  let W = 0, H = 0;
  let stars = [];

  const LAYERS = [
    { count: 60, size: 1, speed: 14, color: '#3a2f6b' },
    { count: 40, size: 1, speed: 26, color: '#5a4a99' },
    { count: 22, size: 2, speed: 42, color: '#a89dc9' },
    { count: 10, size: 2, speed: 60, color: '#4ce0d2' }
  ];

  function resize(){
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W;
    canvas.height = H;
    seedStars();
  }

  function seedStars(){
    stars = [];
    LAYERS.forEach(layer => {
      for(let i = 0; i < layer.count; i++){
        stars.push({
          x: Math.floor(Math.random() * W),
          y: Math.floor(Math.random() * H),
          size: layer.size,
          speed: layer.speed,
          color: layer.color,
          twinklePhase: Math.random() * Math.PI * 2
        });
      }
    });
  }

  let lastTime = 0;
  function loop(now){
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0);
    lastTime = now;

    ctx.clearRect(0, 0, W, H);
    stars.forEach(s => {
      s.y += s.speed * dt;
      if(s.y > H){ s.y = -4; s.x = Math.floor(Math.random() * W); }
      const twinkle = Math.sin(now / 600 + s.twinklePhase) * 0.3 + 0.7;
      ctx.globalAlpha = twinkle;
      ctx.fillStyle = s.color;
      ctx.fillRect(Math.floor(s.x), Math.floor(s.y), s.size, s.size);
    });
    ctx.globalAlpha = 1;

    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(loop);
})();
