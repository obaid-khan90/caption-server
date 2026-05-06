import importlib.util
mods=['cv2','PIL','imageio','moviepy','ffmpeg']
for m in mods:
    print(m, bool(importlib.util.find_spec(m)))
