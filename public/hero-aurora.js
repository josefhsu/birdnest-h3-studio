(() => {
  const canvas = document.getElementById('hero-aurora');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const colors = [
    [34, 234, 193], [42, 157, 255], [87, 87, 255],
    [200, 59, 252], [108, 68, 255], [43, 158, 255],
  ];
  const cycle = 48;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = false;
  let frame = 0;
  let previous = 0;
  let elapsed = 0;

  function palette(seconds) {
    const progress = seconds / cycle * colors.length;
    const step = Math.floor(progress);
    const fraction = progress - step;
    const eased = fraction * fraction * (3 - 2 * fraction);
    const start = colors[step % colors.length];
    const end = colors[(step + 1) % colors.length];
    return start.map((channel, i) => Math.round(channel + (end[i] - channel) * eased));
  }

  const rgba = (color, alpha) => 'rgba(' + color.join(',') + ',' + alpha + ')';
  const colorMix = (a, b, amount) => a.map((channel, i) => Math.round(channel + (b[i] - channel) * amount));

  function draw() {
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    const seconds = reducedMotion.matches ? 0 : elapsed;
    const phase = seconds / cycle * Math.PI * 2;
    const base = palette(seconds);
    const cool = palette(seconds + 7);
    const flare = colorMix(base, [220, 249, 255], .72);

    ctx.setTransform(canvas.width, 0, 0, canvas.height, 0, 0);
    ctx.clearRect(0, 0, 1, 1);
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'screen';

    const crest = x => .284 + 1.34 * (x - .65) ** 2
      + .040 * Math.sin(x * 8 - phase * 2)
      + .018 * Math.sin(x * 16 + phase * 2);
    const spread = x => .072 + .29 * (1 - x) ** 2;

    function ribbon(offset, width, alpha, color, edge = color) {
      const tint = ctx.createLinearGradient(0, 0, 1, 0);
      tint.addColorStop(0, rgba(edge, 0));
      tint.addColorStop(.12, rgba(edge, alpha * .55));
      tint.addColorStop(.33, rgba(color, alpha));
      tint.addColorStop(.62, rgba(color, alpha * .93));
      tint.addColorStop(.84, rgba(edge, alpha * .50));
      tint.addColorStop(1, rgba(edge, 0));
      ctx.strokeStyle = tint;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i <= 60; i++) {
        const x = i / 60;
        const ruffle = Math.sin(x * 17 + offset * 3 - phase * 4);
        const y = crest(x) + offset * spread(x) + offset * .011 * ruffle;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }

    // Overlapping translucent layers soften the glow around both sides of the crest.
    for (let i = -6; i <= 16; i++) {
      const falloff = Math.exp(-(((i - 1) / 9) ** 2));
      ribbon(i / 10, .070, .042 * falloff, cool, base);
    }

    // Narrow folds trace the hanging curtain under the bright edge.
    for (let i = 0; i < 58; i++) {
      const x = .035 + i * .0157;
      const flutter = .65 + .35 * Math.sin(x * 65 - phase * 7 + Math.sin(x * 19));
      const start = crest(x) + .010;
      const end = start + spread(x) * (1.05 + .77 * flutter);
      const slant = .018 + (x - .57) * .20;
      const alpha = .04 + .14 * flutter;
      const light = ctx.createLinearGradient(x, start, x + slant, end);
      light.addColorStop(0, rgba(base, 0));
      light.addColorStop(.23, rgba(base, alpha));
      light.addColorStop(.55, rgba(cool, alpha * .72));
      light.addColorStop(1, rgba(cool, 0));
      ctx.strokeStyle = light;
      ctx.lineWidth = .0035 + flutter * .0055;
      ctx.beginPath();
      ctx.moveTo(x, start);
      ctx.quadraticCurveTo(x + slant * .22, start + (end - start) * .52, x + slant, end);
      ctx.stroke();
    }

    ribbon(-.25, .057, .19, base, cool);
    ribbon(-.15, .027, .23, colorMix(base, flare, .36), cool);
    ribbon(.02, .107, .20, base, cool);
    ribbon(.035, .056, .34, base, cool);
    ribbon(.03, .025, .44, colorMix(base, flare, .53), base);
    ribbon(.01, .009, .38, flare, base);
    ribbon(.39, .035, .18, colorMix(base, cool, .35), cool);
    canvas.dataset.ready = '';
  }

  function animate(now) {
    frame = 0;
    if (!visible || document.hidden || reducedMotion.matches) return;
    if (!previous || now - previous >= 1000 / 30) {
      if (previous) elapsed = (elapsed + Math.min(now - previous, 90) / 1000) % cycle;
      previous = now;
      draw();
    }
    frame = requestAnimationFrame(animate);
  }

  function update() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
    if (!visible || document.hidden) return;
    draw();
    if (!reducedMotion.matches) frame = requestAnimationFrame(animate);
  }

  const size = new ResizeObserver(([{ contentRect }]) => {
    if (!contentRect.width || !contentRect.height) return;
    const scale = Math.min(devicePixelRatio, 1.25, 920 / contentRect.width);
    canvas.width = Math.max(1, Math.round(contentRect.width * scale));
    canvas.height = Math.max(1, Math.round(contentRect.height * scale));
    update();
  });
  size.observe(canvas);

  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    update();
  });
  intersection.observe(canvas);
  document.addEventListener('visibilitychange', update);
  reducedMotion.addEventListener('change', update);
})();
