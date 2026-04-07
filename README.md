# Transcribe

Aplicación web estática para transcribir archivos locales de audio y vídeo directamente en el navegador.

## Qué hace

- Carga archivos locales `audio/*` y `video/*`
- Reproduce el archivo en la propia página
- Extrae audio de vídeos con `ffmpeg.wasm`
- Transcribe localmente con Whisper en el navegador
- Permite descargar el resultado en `txt`, `srt` y `vtt`

## Stack

- React + TypeScript + Vite
- `@huggingface/transformers` para ASR en cliente
- `@ffmpeg/ffmpeg` y `@ffmpeg/util` para extraer audio de vídeo

## Arranque

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

La configuración usa `base: './'` en [vite.config.ts](/home/jjdeharo/Documentos/github/media2text/vite.config.ts), así que el contenido generado en `dist/` se puede publicar como sitio estático.

## Límites actuales

- La primera ejecución descarga modelos Whisper y `ffmpeg.wasm`, así que la carga inicial es pesada.
- El rendimiento depende bastante del equipo del usuario.
- Los vídeos largos pueden tardar bastante porque todo el proceso se hace en cliente.
- La compatibilidad real de formatos depende del navegador y de los códecs que soporte.
