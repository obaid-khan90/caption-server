import os
import imageio.v3 as iio
video = r'D:\caption-server\temp-review.mp4'
outdir = r'D:\caption-server\review_frames'
os.makedirs(outdir, exist_ok=True)
meta = iio.immeta(video)
print(meta)
# sample 6 evenly spaced moments in first 8 seconds or full duration
fps = meta.get('fps', 30) or 30
nframes = meta.get('nframes') or meta.get('duration') and int(meta.get('duration')*fps) or 0
if not nframes:
    # fallback: iterate estimate a few frames
    nframes = int((meta.get('duration') or 6) * fps)
indices = sorted(set([int(fps*t) for t in [0.8,1.6,2.4,3.2,4.0,5.0] if int(fps*t) < nframes]))
for idx in indices:
    frame = iio.imread(video, index=idx)
    path = os.path.join(outdir, f'frame_{idx}.png')
    iio.imwrite(path, frame)
    print(path)
