import os
import imageio.v3 as iio
video = r'C:\Users\user\Desktop\test-variant-outline-1778058864012.mp4'
outdir = r'D:\caption-server\review_outline_frames'
os.makedirs(outdir, exist_ok=True)
meta = iio.immeta(video)
print(meta)
fps = meta.get('fps', 25.0) or 25.0
indices = sorted(set([int(fps*t) for t in [0.8,1.6,2.4,3.2,4.0,5.0]]))
for idx in indices:
    frame = iio.imread(video, index=idx)
    path = os.path.join(outdir, f'frame_{idx}.png')
    iio.imwrite(path, frame)
    print(path)
