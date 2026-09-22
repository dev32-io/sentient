# Attachment parser third-party notices

Base image is Debian 12 (Bookworm), pinned by digest. Installed parser packages are pinned to versions tested by P1:

- Poppler utilities 22.12.0-2+deb12u3: GPL-2 or GPL-3; mixed component notices remain in `/usr/share/doc/poppler-utils/copyright` and related package copyright files.
- libvips tools 8.14.1-3+deb12u3: LGPL-2.1-or-later; notice remains in `/usr/share/doc/libvips42/copyright`.
- libheif 1.15.1-1+deb12u1: library LGPL-3-or-later, Debian packaging GPL-3+, examples MIT; notice remains in `/usr/share/doc/libheif1/copyright`.
- FFmpeg 5.1.9 Debian packages: GPL-2-or-later/LGPL-2.1-or-later depending component; notices remain under `/usr/share/doc/ffmpeg` and library package copyright files.
- pyvips 2.2.2: MIT; installed as the small Python binding over the pinned system libvips, with package metadata retained under `/usr/local/lib/python3.11/dist-packages`.
- Python 3.11.2 Debian packages: Python Software Foundation license and Debian component notices remain under `/usr/share/doc`.

Corresponding Debian source packages are available from https://sources.debian.org/ and https://snapshot.debian.org/. Release packaging must retain Debian copyright files and satisfy applicable GPL/LGPL source and relinking obligations.
