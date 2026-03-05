# pi-ffmpeg

ffmpeg Swiss Army knife for [pi](https://github.com/nicobailon/pi).

## Install

```
npm install -g pi-ffmpeg
```

Requires `ffmpeg` and `ffprobe` in your PATH:
- **Windows**: `winget install ffmpeg`
- **macOS**: `brew install ffmpeg`
- **Linux**: `apt install ffmpeg`

## Commands

| Command | Description |
|---|---|
| `/ffprobe <file>` | Inspect video/audio metadata |
| `/ffmpeg <args>` | Run raw ffmpeg command |
| `/transcode <in> <out> [opts]` | Convert codec, resolution, framerate |
| `/trim <file> <start> [end] [out]` | Cut a clip (stream copy — fast) |
| `/concat <f1> <f2> ... <out>` | Join files |
| `/compress <file> [out] [crf]` | Quick h264 compress |
| `/speed <file> <factor> [out]` | Speed up / slow down |
| `/gif <file> [out] [--fps N]` | Video → animated GIF |
| `/frames <file> [dir] [--fps N]` | Extract frames as images |
| `/thumbnail <file> [out] [time]` | Grab a single frame |
| `/extractaudio <video> [out]` | Rip audio track |
| `/addaudio <video> <audio> [out]` | Mux audio onto video |
| `/ffmpeg-help` | Show all commands |

## LLM Tools

All commands are also available as LLM-callable tools:

`ffmpeg_probe` · `ffmpeg_transcode` · `ffmpeg_trim` · `ffmpeg_concat` · `ffmpeg_gif` · `ffmpeg_frames` · `ffmpeg_thumbnail` · `ffmpeg_extract_audio` · `ffmpeg_add_audio` · `ffmpeg_compress` · `ffmpeg_speed` · `ffmpeg_raw`

## License

MIT
