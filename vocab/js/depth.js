/**
 * The field behind the app, given somewhere to move.
 *
 * Two inputs, one transform. The pointer tilts the whole stage by three
 * degrees — three, not fifteen, because the field is meant to sit behind the
 * app rather than compete with it — and the scroll drives a parallax where
 * each slab carries a fraction of the distance set by its own depth. That
 * second part is the one that matters: without it a perspective background is
 * a picture of depth, and with it the page reads as travelling through
 * something.
 *
 * Everything here is decoration, so everything here is optional. No field in
 * the markup, no work. Reduced motion, no listeners at all — the geometry
 * stays and the movement never starts, which is the honest reading of that
 * preference for an effect whose whole point is the arrangement.
 */
const TILT_Y = 3;      // degrees, left to right
const TILT_X = 2.2;    // degrees, top to bottom
const DRAG = 0.34;     // how much of the scroll the nearest slab carries

export function startDepth() {
  const stage = document.getElementById('fieldStage');
  if (!stage) return () => {};
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};

  let queued = false;
  let mx = 0;
  let my = 0;

  const paint = () => {
    queued = false;
    stage.style.setProperty('--f-tilt-y', `${(mx * TILT_Y).toFixed(2)}deg`);
    stage.style.setProperty('--f-tilt-x', `${(my * -TILT_X).toFixed(2)}deg`);
    stage.style.setProperty('--f-scroll', `${(-scrollY * DRAG).toFixed(1)}px`);
  };
  /* One frame at most, however many events arrive. A pointermove fires far
     faster than the screen refreshes, and writing a transform per event is
     how a background starts costing a phone its battery. */
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };

  const onMove = (e) => {
    mx = (e.clientX / innerWidth) * 2 - 1;
    my = (e.clientY / innerHeight) * 2 - 1;
    queue();
  };

  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('scroll', queue, { passive: true });
  paint();

  return () => {
    removeEventListener('pointermove', onMove);
    removeEventListener('scroll', queue);
  };
}
