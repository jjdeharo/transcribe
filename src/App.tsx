import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import './App.css'
import {
  TranscriptionError,
  extractMono16kAudio,
  formatBytes,
  formatDuration,
  isVideoFile,
} from './lib/audio'
import {
  downloadTextFile,
  makeOutputBaseName,
  toSrt,
  toTxt,
  toVtt,
} from './lib/export'
import { parseSubtitleFile } from './lib/subtitles'

type Segment = {
  id: number
  start: number
  end: number
  text: string
}

type WorkerSuccess = {
  segments: Segment[]
  text: string
  detectedLanguage: string | null
}

type WorkerRequest = {
  type: 'transcribe'
  payload: {
    duration: number
    language: string | null
    modelId: string
    samples: ArrayBufferLike
  }
}

type WorkerMessage =
  | { type: 'status'; payload: string }
  | { type: 'download'; payload: { file?: string; progress?: number; status?: string; loaded?: number; total?: number } }
  | { type: 'chunkProgress'; payload: { completed: number; total: number } }
  | { type: 'result'; payload: WorkerSuccess }
  | { type: 'error'; payload: string }

type PersistedFileInfo = {
  lastModified: number
  name: string
  size: number
  type: string
}

type PersistedSession = {
  detectedLanguage: string | null
  fileInfo: PersistedFileInfo | null
  id: string
  lastRunSeconds: number | null
  modelId: string
  plainText: string
  savedAt: number
  segments: Segment[]
  showSegments: boolean
  version: 2
}

type PersistedStore = {
  sessions: PersistedSession[]
  version: 3
}

type EditableSnapshot = {
  detectedLanguage: string | null
  plainText: string
  segments: Segment[]
  showSegments: boolean
}

type SupportedUiLanguage = 'es' | 'en' | 'ca' | 'gl' | 'eu'
type UiLanguageSetting = SupportedUiLanguage | 'auto'

const MODEL_OPTIONS = [
  {
    id: 'onnx-community/whisper-tiny',
    label: 'Whisper Tiny',
    description: 'Más rápido y ligero para pruebas, notas cortas y equipos modestos',
  },
  {
    id: 'onnx-community/whisper-base',
    label: 'Whisper Base',
    description: 'Equilibrio entre velocidad y calidad para la mayoría de audios',
  },
  {
    id: 'onnx-community/whisper-small',
    label: 'Whisper Small',
    description: 'Mejor para audios algo más difíciles, varios hablantes o idiomas menos claros',
  },
] as const

const DEFAULT_MODEL_ID = 'onnx-community/whisper-base'
const DEFAULT_PERSISTED_SESSIONS_LIMIT = 10
const MAX_PERSISTED_SESSIONS_LIMIT = 30
const APP_VERSION = import.meta.env.VITE_APP_VERSION

const SESSION_STORAGE_KEY = 'media2text-session'
const SESSION_LIMIT_STORAGE_KEY = 'media2text-session-limit'
const UI_LANGUAGE_STORAGE_KEY = 'media2text-ui-language'

const UI_LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
  { value: 'ca', label: 'Català' },
  { value: 'gl', label: 'Galego' },
  { value: 'eu', label: 'Euskara' },
] as const

const UI_STRINGS = {
  es: {
    appName: 'Transcribe',
    heroTitle: 'Transcribe audio y vídeo local',
    heroSubtitle: 'Carga un archivo local, obtén el texto, edítalo y descárgalo como texto plano o como subtítulos. No se envían datos a terceros: todo se realiza en el navegador.',
    selectMedia: 'Seleccionar audio o vídeo',
    importSubtitles: 'Importar SRT o VTT',
    localMediaHint: 'Admite audio y vídeo locales compatibles con tu navegador.',
    model: 'Modelo',
    uiLanguage: 'Idioma de la interfaz',
    audioSourceLanguage: 'Idioma del audio de origen',
    selectLanguage: 'Selecciona un idioma',
    selectUiLanguage: 'Selecciona idioma',
    startTranscription: 'Iniciar transcripción',
    transcribing: 'Transcribiendo…',
    cancel: 'Cancelar',
    status: 'Estado',
    modelDownload: 'Descarga del modelo',
    saveAs: 'Guardar',
    copyAs: 'Copiar',
    currentTime: 'Tiempo actual',
    lastRun: 'Última ejecución',
    noData: 'sin datos',
    footerLicensedUnder: 'Código bajo licencia',
    feedbackIssues: 'Sugerencias y errores',
    localStorageTitle: 'Guardado local',
    show: 'Mostrar',
    hide: 'Ocultar',
    limit: 'Límite',
    clearAll: 'Borrar todo',
    savedSummary: '{count} de {limit} guardadas · {size} aprox. en el navegador',
    recover: 'Recuperar',
    delete: 'Borrar',
    file: 'Archivo',
    video: 'Vídeo',
    audio: 'Audio',
    noFile: 'Sin archivo',
    transcriptionTrack: 'Transcripción',
    noMediaLoaded: 'Todavía no has cargado ningún archivo.',
    extractedText: 'Texto extraído',
    extractedTextHint: 'Si quieres corregir subtítulos o tiempos, edita los fragmentos temporizados. Este cuadro sirve sobre todo para revisar, copiar o exportar.',
    fragmentsTimed: 'Fragmentos temporizados',
    noBlocks: 'Aún no hay bloques',
    blocksCount: '{count} bloques',
    undo: 'Deshacer',
    redo: 'Rehacer',
    split: 'Dividir',
    mergeNext: 'Unir siguiente',
    plainTextPlaceholder: 'La transcripción aparecerá aquí.',
    emptySegments: 'Ejecuta una transcripción para obtener texto con marcas temporales y poder exportarlo como subtítulos.',
    uiLanguageAuto: 'Automático',
    languageSpanish: 'Español',
    languageCatalan: 'Catalán',
    languageGalician: 'Gallego',
    languageBasque: 'Euskera',
    languageEnglish: 'Inglés',
    languageGerman: 'Alemán',
    languageFrench: 'Francés',
    languagePortuguese: 'Portugués',
    languageItalian: 'Italiano',
    languageDutch: 'Neerlandés',
    languageRomanian: 'Rumano',
    languagePolish: 'Polaco',
    languageCzech: 'Checo',
    languageGreek: 'Griego',
    languageTurkish: 'Turco',
    languageRussian: 'Ruso',
    languageUkrainian: 'Ucraniano',
    languageArabic: 'Árabe',
    languageHebrew: 'Hebreo',
    languageHindi: 'Hindi',
    languageUrdu: 'Urdu',
    languageChinese: 'Chino',
    languageJapanese: 'Japonés',
    languageKorean: 'Coreano',
    languageIndonesian: 'Indonesio',
    languageVietnamese: 'Vietnamita',
    modelTinyDescription: 'Más rápido y ligero; ideal para pruebas, notas breves o equipos modestos',
    modelBaseDescription: 'El mejor equilibrio entre velocidad y calidad para la mayoría de los usos',
    modelSmallDescription: 'Suele rendir mejor con audios algo más difíciles, varios hablantes o idiomas menos claros',
    savedSessionNoFile: 'Transcripción sin archivo asociado',
    copied: 'Texto copiado al portapapeles.',
    copyFailed: 'No se pudo copiar el texto al portapapeles.',
    copiedFormat: '{format} copiado al portapapeles.',
    copyFailedFormat: 'No se pudo copiar {format} al portapapeles.',
    sessionRestored: 'Sesión restaurada. Vuelve a cargar el archivo si quieres previsualizar o sincronizar con el vídeo.',
    localTranscriptionRestored: 'Transcripción restaurada desde el guardado local.',
    recoveredForCurrentFile: 'Archivo cargado. Transcripción recuperada del guardado local y sincronizada con el medio.',
    fileLoadedSelectAudioLanguage: 'Archivo cargado. Selecciona el idioma del audio de origen para transcribir.',
    missingAudioLanguage: 'Falta seleccionar el idioma del audio de origen.',
    subtitleImportFailed: 'La importación de subtítulos no pudo completarse.',
    transcriptionFailed: 'La transcripción no pudo completarse.',
    transcriptionCanceled: 'Transcripción cancelada.',
    subtitleImported: 'Archivo de subtítulos importado. {count} fragmentos disponibles.',
    transcriptionCompleted: 'Transcripción completada. {count} fragmentos detectados.',
    validationNoSegments: 'No se han encontrado fragmentos válidos en el archivo.',
    importFileFailed: 'No se pudo importar el archivo de subtítulos.',
    workerUnavailable: 'El worker de transcripción no está disponible.',
    missingAudioLanguageError: 'Selecciona el idioma del audio de origen antes de transcribir.',
    genericTranscriptionFailure: 'No se pudo completar la transcripción.',
    canceledByUser: 'Transcripción cancelada por el usuario.',
  },
  en: {
    appName: 'Transcribe',
    heroTitle: 'Transcribe local audio and video',
    heroSubtitle: 'Load a local file, extract the text, edit it, and download it as plain text or subtitles. No data is sent to third parties: everything runs in the browser.',
    selectMedia: 'Select audio or video',
    importSubtitles: 'Import SRT or VTT',
    localMediaHint: 'Supports local audio and video files compatible with your browser.',
    model: 'Model',
    uiLanguage: 'Interface language',
    audioSourceLanguage: 'Source audio language',
    selectLanguage: 'Select a language',
    selectUiLanguage: 'Select language',
    startTranscription: 'Start transcription',
    transcribing: 'Transcribing…',
    cancel: 'Cancel',
    status: 'Status',
    modelDownload: 'Model download',
    saveAs: 'Save',
    copyAs: 'Copy',
    currentTime: 'Current time',
    lastRun: 'Last run',
    noData: 'no data',
    footerLicensedUnder: 'Code licensed under',
    feedbackIssues: 'Suggestions and bugs',
    localStorageTitle: 'Local storage',
    show: 'Show',
    hide: 'Hide',
    limit: 'Limit',
    clearAll: 'Clear all',
    savedSummary: '{count} of {limit} saved · about {size} in browser storage',
    recover: 'Restore',
    delete: 'Delete',
    file: 'File',
    video: 'Video',
    audio: 'Audio',
    noFile: 'No file',
    transcriptionTrack: 'Transcription',
    noMediaLoaded: 'You have not loaded any file yet.',
    extractedText: 'Extracted text',
    extractedTextHint: 'If you want to correct subtitles or timings, edit the timed segments. This box is mainly for reviewing, copying, or exporting.',
    fragmentsTimed: 'Timed segments',
    noBlocks: 'No blocks yet',
    blocksCount: '{count} blocks',
    undo: 'Undo',
    redo: 'Redo',
    split: 'Split',
    mergeNext: 'Merge next',
    plainTextPlaceholder: 'The transcription will appear here.',
    emptySegments: 'Run a transcription to get timestamped text and export it as subtitles.',
    uiLanguageAuto: 'Automatic',
    languageSpanish: 'Spanish',
    languageCatalan: 'Catalan',
    languageGalician: 'Galician',
    languageBasque: 'Basque',
    languageEnglish: 'English',
    languageGerman: 'German',
    languageFrench: 'French',
    languagePortuguese: 'Portuguese',
    languageItalian: 'Italian',
    languageDutch: 'Dutch',
    languageRomanian: 'Romanian',
    languagePolish: 'Polish',
    languageCzech: 'Czech',
    languageGreek: 'Greek',
    languageTurkish: 'Turkish',
    languageRussian: 'Russian',
    languageUkrainian: 'Ukrainian',
    languageArabic: 'Arabic',
    languageHebrew: 'Hebrew',
    languageHindi: 'Hindi',
    languageUrdu: 'Urdu',
    languageChinese: 'Chinese',
    languageJapanese: 'Japanese',
    languageKorean: 'Korean',
    languageIndonesian: 'Indonesian',
    languageVietnamese: 'Vietnamese',
    modelTinyDescription: 'Fastest and lightest; ideal for quick tests, short notes, or modest devices',
    modelBaseDescription: 'Best balance between speed and quality for most use cases',
    modelSmallDescription: 'Often better for trickier audio, multiple speakers, or less clear language',
    savedSessionNoFile: 'Transcription without associated file',
    copied: 'Text copied to clipboard.',
    copyFailed: 'Could not copy text to clipboard.',
    copiedFormat: '{format} copied to clipboard.',
    copyFailedFormat: 'Could not copy {format} to clipboard.',
    sessionRestored: 'Session restored. Reload the file if you want preview or media sync.',
    localTranscriptionRestored: 'Transcription restored from local storage.',
    recoveredForCurrentFile: 'File loaded. Transcription restored from local storage and synced with the media.',
    fileLoadedSelectAudioLanguage: 'File loaded. Select the source audio language to transcribe.',
    missingAudioLanguage: 'The source audio language is still missing.',
    subtitleImportFailed: 'Subtitle import could not be completed.',
    transcriptionFailed: 'The transcription could not be completed.',
    transcriptionCanceled: 'Transcription canceled.',
    subtitleImported: 'Subtitle file imported. {count} segments available.',
    transcriptionCompleted: 'Transcription completed. {count} segments detected.',
    validationNoSegments: 'No valid segments were found in the file.',
    importFileFailed: 'Could not import the subtitle file.',
    workerUnavailable: 'The transcription worker is not available.',
    missingAudioLanguageError: 'Select the source audio language before transcribing.',
    genericTranscriptionFailure: 'The transcription could not be completed.',
    canceledByUser: 'Transcription canceled by the user.',
  },
  ca: {
    appName: 'Transcribe',
    heroTitle: 'Transcriu àudio i vídeo local',
    heroSubtitle: 'Carrega un fitxer local, obtén el text, edita\'l i descarrega\'l com a text pla o subtítols. No s’envien dades a tercers: tot es fa al navegador.',
    selectMedia: 'Selecciona àudio o vídeo',
    importSubtitles: 'Importa SRT o VTT',
    localMediaHint: 'Admet àudio i vídeo locals compatibles amb el navegador.',
    model: 'Model',
    uiLanguage: 'Idioma de la interfície',
    audioSourceLanguage: 'Idioma d\'origen de l\'àudio',
    selectLanguage: 'Selecciona un idioma',
    selectUiLanguage: 'Selecciona idioma',
    startTranscription: 'Inicia la transcripció',
    transcribing: 'Transcrivint…',
    cancel: 'Cancel·la',
    status: 'Estat',
    modelDownload: 'Descàrrega del model',
    saveAs: 'Desa',
    copyAs: 'Copia',
    currentTime: 'Temps actual',
    lastRun: 'Darrera execució',
    noData: 'sense dades',
    footerLicensedUnder: 'Codi sota llicència',
    feedbackIssues: 'Suggeriments i errors',
    localStorageTitle: 'Emmagatzematge local',
    show: 'Mostra',
    hide: 'Amaga',
    limit: 'Límit',
    clearAll: 'Esborra-ho tot',
    savedSummary: '{count} de {limit} desades · {size} aprox. al navegador',
    recover: 'Recupera',
    delete: 'Esborra',
    file: 'Fitxer',
    video: 'Vídeo',
    audio: 'Àudio',
    noFile: 'Cap fitxer',
    transcriptionTrack: 'Transcripció',
    noMediaLoaded: 'Encara no has carregat cap fitxer.',
    extractedText: 'Text extret',
    extractedTextHint: 'Si vols corregir subtítols o temps, edita els fragments temporitzats. Aquest quadre serveix sobretot per revisar, copiar o exportar.',
    fragmentsTimed: 'Fragments temporitzats',
    noBlocks: 'Encara no hi ha blocs',
    blocksCount: '{count} blocs',
    undo: 'Desfés',
    redo: 'Refés',
    split: 'Divideix',
    mergeNext: 'Uneix amb el següent',
    plainTextPlaceholder: 'La transcripció apareixerà aquí.',
    emptySegments: 'Executa una transcripció per obtenir text amb marques temporals i exportar-lo com a subtítols.',
    uiLanguageAuto: 'Automàtic',
    languageSpanish: 'Espanyol',
    languageCatalan: 'Català',
    languageGalician: 'Gallec',
    languageBasque: 'Basc',
    languageEnglish: 'Anglès',
    languageGerman: 'Alemany',
    languageFrench: 'Francès',
    languagePortuguese: 'Portuguès',
    languageItalian: 'Italià',
    languageDutch: 'Neerlandès',
    languageRomanian: 'Romanès',
    languagePolish: 'Polonès',
    languageCzech: 'Txec',
    languageGreek: 'Grec',
    languageTurkish: 'Turc',
    languageRussian: 'Rus',
    languageUkrainian: 'Ucraïnès',
    languageArabic: 'Àrab',
    languageHebrew: 'Hebreu',
    languageHindi: 'Hindi',
    languageUrdu: 'Urdú',
    languageChinese: 'Xinès',
    languageJapanese: 'Japonès',
    languageKorean: 'Coreà',
    languageIndonesian: 'Indonesi',
    languageVietnamese: 'Vietnamita',
    modelTinyDescription: 'El més ràpid i lleuger; ideal per a proves, notes breus o equips modestos',
    modelBaseDescription: 'El millor equilibri entre velocitat i qualitat per a la majoria de casos',
    modelSmallDescription: 'Sovint va millor amb àudios més difícils, diversos parlants o idiomes menys clars',
    savedSessionNoFile: 'Transcripció sense fitxer associat',
    copied: 'Text copiat al porta-retalls.',
    copyFailed: 'No s\'ha pogut copiar el text al porta-retalls.',
    copiedFormat: '{format} copiat al porta-retalls.',
    copyFailedFormat: 'No s\'ha pogut copiar {format} al porta-retalls.',
    sessionRestored: 'Sessió restaurada. Torna a carregar el fitxer si vols previsualització o sincronització amb el vídeo.',
    localTranscriptionRestored: 'Transcripció restaurada des del desament local.',
    recoveredForCurrentFile: 'Fitxer carregat. Transcripció recuperada del desament local i sincronitzada amb el mitjà.',
    fileLoadedSelectAudioLanguage: 'Fitxer carregat. Selecciona l’idioma d’origen de l’àudio per transcriure.',
    missingAudioLanguage: 'Falta seleccionar l’idioma d’origen de l’àudio.',
    subtitleImportFailed: 'La importació de subtítols no s’ha pogut completar.',
    transcriptionFailed: 'La transcripció no s’ha pogut completar.',
    transcriptionCanceled: 'Transcripció cancel·lada.',
    subtitleImported: 'Fitxer de subtítols importat. {count} fragments disponibles.',
    transcriptionCompleted: 'Transcripció completada. {count} fragments detectats.',
    validationNoSegments: 'No s’han trobat fragments vàlids al fitxer.',
    importFileFailed: 'No s’ha pogut importar el fitxer de subtítols.',
    workerUnavailable: 'El worker de transcripció no està disponible.',
    missingAudioLanguageError: 'Selecciona l’idioma d’origen de l’àudio abans de transcriure.',
    genericTranscriptionFailure: 'La transcripció no s’ha pogut completar.',
    canceledByUser: 'Transcripció cancel·lada per l’usuari.',
  },
  gl: {
    appName: 'Transcribe',
    heroTitle: 'Transcribe audio e vídeo local',
    heroSubtitle: 'Carga un ficheiro local, obtén o texto, edítao e descárgao como texto plano ou subtítulos. Non se envían datos a terceiros: todo se fai no navegador.',
    selectMedia: 'Seleccionar audio ou vídeo',
    importSubtitles: 'Importar SRT ou VTT',
    localMediaHint: 'Admite audio e vídeo locais compatibles co navegador.',
    model: 'Modelo',
    uiLanguage: 'Idioma da interface',
    audioSourceLanguage: 'Idioma de orixe do audio',
    selectLanguage: 'Selecciona un idioma',
    selectUiLanguage: 'Selecciona idioma',
    startTranscription: 'Iniciar transcrición',
    transcribing: 'Transcribindo…',
    cancel: 'Cancelar',
    status: 'Estado',
    modelDownload: 'Descarga do modelo',
    saveAs: 'Gardar',
    copyAs: 'Copiar',
    currentTime: 'Tempo actual',
    lastRun: 'Última execución',
    noData: 'sen datos',
    footerLicensedUnder: 'Código baixo licenza',
    feedbackIssues: 'Suxestións e erros',
    localStorageTitle: 'Garda local',
    show: 'Amosar',
    hide: 'Agochar',
    limit: 'Límite',
    clearAll: 'Borrar todo',
    savedSummary: '{count} de {limit} gardadas · {size} aprox. no navegador',
    recover: 'Recuperar',
    delete: 'Borrar',
    file: 'Ficheiro',
    video: 'Vídeo',
    audio: 'Audio',
    noFile: 'Sen ficheiro',
    transcriptionTrack: 'Transcrición',
    noMediaLoaded: 'Aínda non cargaches ningún ficheiro.',
    extractedText: 'Texto extraído',
    extractedTextHint: 'Se queres corrixir subtítulos ou tempos, edita os fragmentos temporizados. Este cadro serve sobre todo para revisar, copiar ou exportar.',
    fragmentsTimed: 'Fragmentos temporizados',
    noBlocks: 'Aínda non hai bloques',
    blocksCount: '{count} bloques',
    undo: 'Desfacer',
    redo: 'Refacer',
    split: 'Dividir',
    mergeNext: 'Unir seguinte',
    plainTextPlaceholder: 'A transcrición aparecerá aquí.',
    emptySegments: 'Executa unha transcrición para obter texto con marcas temporais e poder exportalo como subtítulos.',
    uiLanguageAuto: 'Automático',
    languageSpanish: 'Español',
    languageCatalan: 'Catalán',
    languageGalician: 'Galego',
    languageBasque: 'Éuscaro',
    languageEnglish: 'Inglés',
    languageGerman: 'Alemán',
    languageFrench: 'Francés',
    languagePortuguese: 'Portugués',
    languageItalian: 'Italiano',
    languageDutch: 'Neerlandés',
    languageRomanian: 'Romanés',
    languagePolish: 'Polaco',
    languageCzech: 'Checo',
    languageGreek: 'Grego',
    languageTurkish: 'Turco',
    languageRussian: 'Ruso',
    languageUkrainian: 'Ucraíno',
    languageArabic: 'Árabe',
    languageHebrew: 'Hebreo',
    languageHindi: 'Hindi',
    languageUrdu: 'Urdu',
    languageChinese: 'Chinés',
    languageJapanese: 'Xaponés',
    languageKorean: 'Coreano',
    languageIndonesian: 'Indonesio',
    languageVietnamese: 'Vietnamita',
    modelTinyDescription: 'O máis rápido e lixeiro; ideal para probas, notas breves ou equipos modestos',
    modelBaseDescription: 'O mellor equilibrio entre velocidade e calidade para a maioría dos casos',
    modelSmallDescription: 'Adoita ir mellor con audios máis difíciles, varias voces ou idiomas menos claros',
    savedSessionNoFile: 'Transcrición sen ficheiro asociado',
    copied: 'Texto copiado ao portapapeis.',
    copyFailed: 'Non se puido copiar o texto ao portapapeis.',
    copiedFormat: '{format} copiado ao portapapeis.',
    copyFailedFormat: 'Non se puido copiar {format} ao portapapeis.',
    sessionRestored: 'Sesión restaurada. Volve cargar o ficheiro se queres previsualización ou sincronización co vídeo.',
    localTranscriptionRestored: 'Transcrición restaurada desde o gardado local.',
    recoveredForCurrentFile: 'Ficheiro cargado. Transcrición recuperada do gardado local e sincronizada co medio.',
    fileLoadedSelectAudioLanguage: 'Ficheiro cargado. Selecciona o idioma de orixe do audio para transcribir.',
    missingAudioLanguage: 'Falta seleccionar o idioma de orixe do audio.',
    subtitleImportFailed: 'A importación de subtítulos non se puido completar.',
    transcriptionFailed: 'A transcrición non se puido completar.',
    transcriptionCanceled: 'Transcrición cancelada.',
    subtitleImported: 'Ficheiro de subtítulos importado. {count} fragmentos dispoñibles.',
    transcriptionCompleted: 'Transcrición completada. {count} fragmentos detectados.',
    validationNoSegments: 'Non se atoparon fragmentos válidos no ficheiro.',
    importFileFailed: 'Non se puido importar o ficheiro de subtítulos.',
    workerUnavailable: 'O worker de transcrición non está dispoñible.',
    missingAudioLanguageError: 'Selecciona o idioma de orixe do audio antes de transcribir.',
    genericTranscriptionFailure: 'A transcrición non se puido completar.',
    canceledByUser: 'Transcrición cancelada polo usuario.',
  },
  eu: {
    appName: 'Transcribe',
    heroTitle: 'Tokiko audioa eta bideoa transkribatu',
    heroSubtitle: 'Kargatu fitxategi lokal bat, atera testua, editatu eta deskargatu testu arrunt edo azpititulu gisa. Ez da daturik hirugarrenei bidaltzen: dena nabigatzailean egiten da.',
    selectMedia: 'Hautatu audioa edo bideoa',
    importSubtitles: 'Inportatu SRT edo VTT',
    localMediaHint: 'Zure nabigatzailearekin bateragarriak diren tokiko audio eta bideo fitxategiak onartzen ditu.',
    model: 'Eredua',
    uiLanguage: 'Interfazearen hizkuntza',
    audioSourceLanguage: 'Audioaren jatorrizko hizkuntza',
    selectLanguage: 'Hautatu hizkuntza bat',
    selectUiLanguage: 'Hautatu hizkuntza',
    startTranscription: 'Hasi transkripzioa',
    transcribing: 'Transkribatzen…',
    cancel: 'Utzi',
    status: 'Egoera',
    modelDownload: 'Ereduaren deskarga',
    saveAs: 'Gorde',
    copyAs: 'Kopiatu',
    currentTime: 'Uneko denbora',
    lastRun: 'Azken exekuzioa',
    noData: 'daturik ez',
    footerLicensedUnder: 'Kodea lizentzia honekin',
    feedbackIssues: 'Iradokizunak eta erroreak',
    localStorageTitle: 'Tokiko gordailua',
    show: 'Erakutsi',
    hide: 'Ezkutatu',
    limit: 'Muga',
    clearAll: 'Ezabatu dena',
    savedSummary: '{count} / {limit} gordeta · {size} gutxi gorabehera nabigatzailean',
    recover: 'Berreskuratu',
    delete: 'Ezabatu',
    file: 'Fitxategia',
    video: 'Bideoa',
    audio: 'Audioa',
    noFile: 'Fitxategirik ez',
    transcriptionTrack: 'Transkripzioa',
    noMediaLoaded: 'Oraindik ez duzu fitxategirik kargatu.',
    extractedText: 'Ateratako testua',
    extractedTextHint: 'Azpitituluak edo denborak zuzendu nahi badituzu, editatu denboraz markatutako zatiak. Koadro hau batez ere berrikusi, kopiatu edo esportatzeko da.',
    fragmentsTimed: 'Denboraz markatutako zatiak',
    noBlocks: 'Oraindik ez dago bloketik',
    blocksCount: '{count} bloke',
    undo: 'Desegin',
    redo: 'Berregin',
    split: 'Zatitu',
    mergeNext: 'Hurrengoarekin batu',
    plainTextPlaceholder: 'Transkripzioa hemen agertuko da.',
    emptySegments: 'Exekutatu transkripzio bat denbora-markadun testua lortzeko eta azpititulu gisa esportatzeko.',
    uiLanguageAuto: 'Automatikoa',
    languageSpanish: 'Gaztelania',
    languageCatalan: 'Katalana',
    languageGalician: 'Galegoa',
    languageBasque: 'Euskara',
    languageEnglish: 'Ingelesa',
    languageGerman: 'Alemana',
    languageFrench: 'Frantsesa',
    languagePortuguese: 'Portugesa',
    languageItalian: 'Italiera',
    languageDutch: 'Nederlandera',
    languageRomanian: 'Errumaniera',
    languagePolish: 'Poloniera',
    languageCzech: 'Txekiera',
    languageGreek: 'Greziera',
    languageTurkish: 'Turkiera',
    languageRussian: 'Errusiera',
    languageUkrainian: 'Ukrainera',
    languageArabic: 'Arabiera',
    languageHebrew: 'Hebreera',
    languageHindi: 'Hindia',
    languageUrdu: 'Urdua',
    languageChinese: 'Txinera',
    languageJapanese: 'Japoniera',
    languageKorean: 'Koreera',
    languageIndonesian: 'Indonesiera',
    languageVietnamese: 'Vietnamera',
    modelTinyDescription: 'Azkarrena eta arinena; aproposa probetarako, ohar laburretarako edo baliabide gutxiko gailuetarako',
    modelBaseDescription: 'Abiadura eta kalitatearen arteko orekarik onena erabilera gehienetarako',
    modelSmallDescription: 'Sarritan hobeto dabil audio zailagoekin, hainbat hiztunekin edo hain argiak ez diren hizkuntzekin',
    savedSessionNoFile: 'Lotutako fitxategirik gabeko transkripzioa',
    copied: 'Testua arbelean kopiatu da.',
    copyFailed: 'Ezin izan da testua arbelean kopiatu.',
    copiedFormat: '{format} arbelean kopiatu da.',
    copyFailedFormat: 'Ezin izan da {format} arbelean kopiatu.',
    sessionRestored: 'Saioa leheneratu da. Kargatu berriro fitxategia aurrebista edo bideoarekin sinkronizazioa nahi baduzu.',
    localTranscriptionRestored: 'Transkripzioa tokiko gordailutik leheneratu da.',
    recoveredForCurrentFile: 'Fitxategia kargatu da. Transkripzioa tokiko gordailutik berreskuratu eta multimediarekin sinkronizatu da.',
    fileLoadedSelectAudioLanguage: 'Fitxategia kargatu da. Hautatu audioaren jatorrizko hizkuntza transkribatzeko.',
    missingAudioLanguage: 'Audioaren jatorrizko hizkuntza falta da.',
    subtitleImportFailed: 'Azpitituluen inportazioa ezin izan da osatu.',
    transcriptionFailed: 'Transkripzioa ezin izan da osatu.',
    transcriptionCanceled: 'Transkripzioa bertan behera utzi da.',
    subtitleImported: 'Azpititulu fitxategia inportatu da. {count} zati erabilgarri.',
    transcriptionCompleted: 'Transkripzioa osatu da. {count} zati detektatu dira.',
    validationNoSegments: 'Ez da baliozko zatirik aurkitu fitxategian.',
    importFileFailed: 'Ezin izan da azpititulu fitxategia inportatu.',
    workerUnavailable: 'Transkripzio worker-a ez dago erabilgarri.',
    missingAudioLanguageError: 'Hautatu audioaren jatorrizko hizkuntza transkribatu aurretik.',
    genericTranscriptionFailure: 'Transkripzioa ezin izan da osatu.',
    canceledByUser: 'Erabiltzaileak transkripzioa bertan behera utzi du.',
  },
} as const

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [mediaUrl, setMediaUrl] = useState<string>('')
  const [subtitleTrackUrl, setSubtitleTrackUrl] = useState<string>('')
  const [subtitleTrackVersion, setSubtitleTrackVersion] = useState<number>(0)
  const [modelId, setModelId] = useState<string>(DEFAULT_MODEL_ID)
  const [segments, setSegments] = useState<Segment[]>([])
  const [plainText, setPlainText] = useState<string>('')
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('Selecciona un archivo de audio o vídeo local para empezar.')
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [copyMessage, setCopyMessage] = useState<string>('')
  const [workflowProgress, setWorkflowProgress] = useState<number>(0)
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0)
  const [lastRunSeconds, setLastRunSeconds] = useState<number | null>(null)
  const [showSegments, setShowSegments] = useState(true)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null)
  const [savedSessions, setSavedSessions] = useState<PersistedSession[]>([])
  const [savedSessionsLimit, setSavedSessionsLimit] = useState<number>(DEFAULT_PERSISTED_SESSIONS_LIMIT)
  const [isSavedSessionsExpanded, setIsSavedSessionsExpanded] = useState(false)
  const [uiLanguageSetting, setUiLanguageSetting] = useState<UiLanguageSetting>('auto')

  const workerRef = useRef<Worker | null>(null)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const pendingResolveRef = useRef<((value: WorkerSuccess) => void) | null>(null)
  const pendingRejectRef = useRef<((reason?: unknown) => void) | null>(null)
  const startedAtRef = useRef<number | null>(null)
  const hasHydratedSessionRef = useRef(false)
  const hasSkippedInitialSaveRef = useRef(false)
  const restoredFileInfoRef = useRef<PersistedFileInfo | null>(null)
  const segmentTextareaRefs = useRef<Record<number, HTMLTextAreaElement | null>>({})
  const segmentCardRefs = useRef<Record<number, HTMLElement | null>>({})
  const undoStackRef = useRef<EditableSnapshot[]>([])
  const redoStackRef = useRef<EditableSnapshot[]>([])

  const currentFileInfo = useMemo(
    () => (selectedFile ? toPersistedFileInfo(selectedFile) : restoredFileInfoRef.current),
    [selectedFile],
  )
  const savedSessionsSize = useMemo(() => estimatePersistedSessionsSize(savedSessions, savedSessionsLimit), [savedSessions, savedSessionsLimit])
  const uiLanguage = useMemo(() => resolveUiLanguage(uiLanguageSetting), [uiLanguageSetting])
  const texts = UI_STRINGS[uiLanguage]
  const visibleStatus = downloadProgress === null && status === 'Descargando el modelo de transcripción…'
    ? 'Cargando modelo…'
    : status

  const updateHistoryAvailability = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0)
    setCanRedo(redoStackRef.current.length > 0)
  }, [])

  const restoreSavedSession = useCallback((session: PersistedSession, options?: { statusMessage?: string }) => {
    restoredFileInfoRef.current = session.fileInfo
    setModelId(isKnownModel(session.modelId) ? session.modelId : DEFAULT_MODEL_ID)
    setSegments(session.segments.map((segment) => ({ ...segment })))
    setPlainText(session.plainText)
    setDetectedLanguage(session.detectedLanguage)
    setShowSegments(true)
    setLastRunSeconds(session.lastRunSeconds)
    setWorkflowProgress(session.segments.length > 0 || session.plainText.trim() ? 100 : 0)
    setElapsedSeconds(0)
    setDownloadProgress(null)
    setErrorMessage('')
    setCopyMessage('')
    setActiveSegmentId(null)
    setStatus(
      options?.statusMessage ??
        (session.fileInfo
          ? 'Sesión restaurada. Vuelve a cargar el archivo si quieres previsualizar o sincronizar con el vídeo.'
          : 'Transcripción restaurada desde el guardado local.'),
    )
    undoStackRef.current = []
    redoStackRef.current = []
    updateHistoryAvailability()
  }, [updateHistoryAvailability])

  useEffect(() => {
    workerRef.current = createTranscriptionWorker(
      setStatus,
      setWorkflowProgress,
      setDownloadProgress,
      pendingResolveRef,
      pendingRejectRef,
    )

    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    const persistedLimit = loadPersistedSessionsLimit()
    const persistedUiLanguage = loadUiLanguageSetting()
    const sessions = loadPersistedSessions().slice(0, persistedLimit)
    setSavedSessionsLimit(persistedLimit)
    setUiLanguageSetting(persistedUiLanguage)
    setSavedSessions(sessions)

    const session = sessions[0]
    if (session) {
      restoreSavedSession(session)
    }

    hasHydratedSessionRef.current = true
  }, [restoreSavedSession])

  useEffect(() => {
    if (!hasHydratedSessionRef.current) {
      return
    }

    saveUiLanguageSetting(uiLanguageSetting)
  }, [uiLanguageSetting])

  useEffect(() => {
    return () => {
      if (mediaUrl) {
        URL.revokeObjectURL(mediaUrl)
      }
    }
  }, [mediaUrl])

  useEffect(() => {
    return () => {
      if (subtitleTrackUrl) {
        URL.revokeObjectURL(subtitleTrackUrl)
      }
    }
  }, [subtitleTrackUrl])

  useEffect(() => {
    if (!selectedFile || !isVideoFile(selectedFile)) {
      return
    }

    const nextTrackUrl = segments.length > 0 ? makeSubtitleTrackUrl(segments) : ''
    setSubtitleTrackUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current)
      }
      return nextTrackUrl
    })
    setSubtitleTrackVersion((current) => current + 1)
  }, [segments, selectedFile])

  useEffect(() => {
    const videoElement = videoRef.current
    if (!videoElement || !subtitleTrackUrl) {
      return
    }

    const enableTrack = () => {
      for (const track of Array.from(videoElement.textTracks)) {
        track.mode = 'hidden'
      }

      const firstTrack = videoElement.textTracks[0]
      if (firstTrack) {
        firstTrack.mode = 'showing'
      }
    }

    enableTrack()
    const timer = window.setTimeout(enableTrack, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [subtitleTrackUrl, subtitleTrackVersion])

  useEffect(() => {
    if (!isTranscribing || startedAtRef.current === null) {
      return
    }

    const timer = window.setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000))
      }
    }, 500)

    return () => {
      window.clearInterval(timer)
    }
  }, [isTranscribing])

  useEffect(() => {
    const mediaElement = mediaRef.current
    if (!mediaElement || segments.length === 0) {
      setActiveSegmentId(null)
      return
    }

    const syncActiveSegment = () => {
      const currentTime = mediaElement.currentTime
      const activeSegment =
        segments.find((segment, index) => {
          const nextStart = segments[index + 1]?.start
          if (currentTime < segment.start) {
            return false
          }

          if (typeof nextStart === 'number') {
            return currentTime < nextStart
          }

          return currentTime <= segment.end + 0.1
        }) ?? null

      setActiveSegmentId(activeSegment?.id ?? null)
    }

    syncActiveSegment()
    mediaElement.addEventListener('timeupdate', syncActiveSegment)
    mediaElement.addEventListener('seeked', syncActiveSegment)
    mediaElement.addEventListener('loadedmetadata', syncActiveSegment)

    return () => {
      mediaElement.removeEventListener('timeupdate', syncActiveSegment)
      mediaElement.removeEventListener('seeked', syncActiveSegment)
      mediaElement.removeEventListener('loadedmetadata', syncActiveSegment)
    }
  }, [segments, mediaUrl])

  useEffect(() => {
    if (activeSegmentId === null) {
      return
    }

    const activeCard = segmentCardRefs.current[activeSegmentId]
    if (!activeCard) {
      return
    }

    activeCard.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' })
    activeCard.focus({ preventScroll: true })
  }, [activeSegmentId])

  useEffect(() => {
    if (!hasHydratedSessionRef.current) {
      return
    }

    if (!hasSkippedInitialSaveRef.current) {
      hasSkippedInitialSaveRef.current = true
      return
    }

    if (segments.length === 0 && plainText.trim().length === 0) {
      return
    }

    const nextSessions = savePersistedSessions({
      detectedLanguage,
      fileInfo: currentFileInfo,
      id: '',
      lastRunSeconds,
      modelId,
      plainText,
      savedAt: Date.now(),
      segments,
      showSegments,
      version: 2,
    }, savedSessionsLimit)
    setSavedSessions(nextSessions)
  }, [currentFileInfo, detectedLanguage, lastRunSeconds, modelId, plainText, savedSessionsLimit, segments, showSegments])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const usesModifier = event.metaKey || event.ctrlKey
      if (!usesModifier || event.altKey) {
        return
      }

      const key = event.key.toLowerCase()
      if (key === 'z' && event.shiftKey) {
        event.preventDefault()
        handleRedo()
        return
      }

      if (key === 'y') {
        event.preventDefault()
        handleRedo()
        return
      }

      if (key === 'z') {
        event.preventDefault()
        handleUndo()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  useEffect(() => {
    if (!copyMessage) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setCopyMessage('')
    }, 2400)

    return () => window.clearTimeout(timeoutId)
  }, [copyMessage])

  const fileSummary = useMemo(() => {
    if (!selectedFile) {
      return ''
    }

    return `${selectedFile.name} · ${formatBytes(selectedFile.size)}`
  }, [selectedFile])

  const canExport = segments.length > 0 || plainText.trim().length > 0

  const resetCurrentSessionState = (options?: { clearLoadedFile?: boolean }) => {
    if (options?.clearLoadedFile) {
      if (mediaUrl) {
        URL.revokeObjectURL(mediaUrl)
      }
      if (subtitleTrackUrl) {
        URL.revokeObjectURL(subtitleTrackUrl)
        setSubtitleTrackUrl('')
      }

      setSelectedFile(null)
      setMediaUrl('')
      setSubtitleTrackVersion(0)
    }

    restoredFileInfoRef.current = null
    setSegments([])
    setPlainText('')
    setDetectedLanguage(null)
    setShowSegments(true)
    setWorkflowProgress(0)
    setElapsedSeconds(0)
    setLastRunSeconds(null)
    setDownloadProgress(null)
    setErrorMessage('')
    setCopyMessage('')
    setActiveSegmentId(null)
    setStatus('Selecciona un archivo.')
    undoStackRef.current = []
    redoStackRef.current = []
    updateHistoryAvailability()
  }

  const createEditableSnapshot = (): EditableSnapshot => ({
    detectedLanguage,
    plainText,
    segments: segments.map((segment) => ({ ...segment })),
    showSegments,
  })

  const applyEditableSnapshot = (snapshot: EditableSnapshot) => {
    setSegments(snapshot.segments.map((segment) => ({ ...segment })))
    setPlainText(snapshot.plainText)
    setDetectedLanguage(snapshot.detectedLanguage)
      setShowSegments(true)
  }

  const commitEditableSnapshot = (snapshot: EditableSnapshot) => {
    const previous = createEditableSnapshot()
    if (editableSnapshotsEqual(previous, snapshot)) {
      return
    }

    undoStackRef.current.push(previous)
    redoStackRef.current = []
    applyEditableSnapshot(snapshot)
    updateHistoryAvailability()
  }

  const handleUndo = () => {
    const previous = undoStackRef.current.pop()
    if (!previous) {
      updateHistoryAvailability()
      return
    }

    redoStackRef.current.push(createEditableSnapshot())
    applyEditableSnapshot(previous)
    updateHistoryAvailability()
  }

  const handleRedo = () => {
    const next = redoStackRef.current.pop()
    if (!next) {
      updateHistoryAvailability()
      return
    }

    undoStackRef.current.push(createEditableSnapshot())
    applyEditableSnapshot(next)
    updateHistoryAvailability()
  }

  const handleFileChange = (file: File | null) => {
    if (mediaUrl) {
      URL.revokeObjectURL(mediaUrl)
    }

    const nextFileInfo = file ? toPersistedFileInfo(file) : null
    const matchingSession = nextFileInfo ? findPersistedSessionByFileInfo(savedSessions, nextFileInfo) : null

    setSelectedFile(file)
    setMediaUrl(file ? URL.createObjectURL(file) : '')
    restoredFileInfoRef.current = nextFileInfo
    if (subtitleTrackUrl) {
      URL.revokeObjectURL(subtitleTrackUrl)
      setSubtitleTrackUrl('')
    }
    setSubtitleTrackVersion(0)
    setErrorMessage('')
    setCopyMessage('')
    setDownloadProgress(null)
    setElapsedSeconds(0)
    setActiveSegmentId(null)

    if (matchingSession) {
      restoreSavedSession(matchingSession, {
        statusMessage: 'Archivo cargado. Transcripción recuperada del guardado local y sincronizada con el medio.',
      })
      return
    }

    setSegments([])
    setPlainText('')
    setDetectedLanguage(null)
    setShowSegments(true)
    setWorkflowProgress(0)
    setLastRunSeconds(null)
    setStatus(file ? 'Archivo cargado. Listo para transcribir.' : 'Selecciona un archivo.')
    undoStackRef.current = []
    redoStackRef.current = []
    updateHistoryAvailability()
  }

  const handleSubtitleImport = async (file: File | null) => {
    if (!file) {
      return
    }

    try {
      const importedSegments = await parseSubtitleFile(file)
      if (importedSegments.length === 0) {
        throw new Error(texts.validationNoSegments)
      }

      commitEditableSnapshot({
        detectedLanguage: null,
        plainText: importedSegments.map((segment) => segment.text.trim()).filter(Boolean).join('\n'),
        segments: importedSegments,
        showSegments: true,
      })
      setErrorMessage('')
      setCopyMessage('')
      setWorkflowProgress(100)
      setStatus(`Archivo de subtítulos importado. ${importedSegments.length} fragmentos disponibles.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : texts.importFileFailed
      setErrorMessage(message)
      setStatus('La importación de subtítulos no pudo completarse.')
    }
  }

  const transcribeWithWorker = async (
    audioData: Float32Array,
    duration: number,
  ): Promise<WorkerSuccess> => {
    const worker = workerRef.current
    if (!worker) {
      throw new Error(texts.workerUnavailable)
    }

    return new Promise<WorkerSuccess>((resolve, reject) => {
      pendingResolveRef.current = resolve
      pendingRejectRef.current = reject

      const request: WorkerRequest = {
        type: 'transcribe',
        payload: {
          duration,
          language: null,
          modelId,
          samples: audioData.buffer,
        },
      }

      worker.postMessage(request, [audioData.buffer])
    })
  }

  const handleTranscribe = async () => {
    if (!selectedFile || isTranscribing) {
      return
    }

    setIsTranscribing(true)
    setErrorMessage('')
    setCopyMessage('')
    setDownloadProgress(null)
    setWorkflowProgress(5)
    setElapsedSeconds(0)
    startedAtRef.current = Date.now()

    try {
      const audioData = await extractMono16kAudio(selectedFile, setStatus)
      const duration = await getMediaDuration(selectedFile)

      setStatus('Transcribiendo en el navegador…')
      setWorkflowProgress(70)
      const result = await transcribeWithWorker(audioData, duration)
      commitEditableSnapshot({
        detectedLanguage: result.detectedLanguage,
        plainText: result.text,
        segments: result.segments,
        showSegments: true,
      })
      setStatus(`Transcripción completada. ${result.segments.length} fragmentos detectados.`)
      setWorkflowProgress(100)
    } catch (error) {
      const message =
        error instanceof TranscriptionError || error instanceof Error
          ? error.message
          : texts.genericTranscriptionFailure
      setErrorMessage(message)
      setStatus('La transcripción no pudo completarse.')
    } finally {
      setIsTranscribing(false)
      setDownloadProgress(null)
      if (startedAtRef.current !== null) {
        const totalSeconds = Math.floor((Date.now() - startedAtRef.current) / 1000)
        setElapsedSeconds(totalSeconds)
        setLastRunSeconds(totalSeconds)
      }
      startedAtRef.current = null
    }
  }

  const handleCancel = () => {
    workerRef.current?.terminate()
    workerRef.current = createTranscriptionWorker(
      setStatus,
      setWorkflowProgress,
      setDownloadProgress,
      pendingResolveRef,
      pendingRejectRef,
    )

    pendingRejectRef.current?.(new Error(texts.canceledByUser))
    pendingResolveRef.current = null
    pendingRejectRef.current = null

    setIsTranscribing(false)
    setDownloadProgress(null)
    setWorkflowProgress(0)
    setStatus('Transcripción cancelada.')
    setErrorMessage('')
    setCopyMessage('')
    if (startedAtRef.current !== null) {
      const totalSeconds = Math.floor((Date.now() - startedAtRef.current) / 1000)
      setElapsedSeconds(totalSeconds)
      setLastRunSeconds(totalSeconds)
    }
    startedAtRef.current = null
  }

  const handleSavedSessionRestore = (session: PersistedSession) => {
    if (mediaUrl) {
      URL.revokeObjectURL(mediaUrl)
    }
    if (subtitleTrackUrl) {
      URL.revokeObjectURL(subtitleTrackUrl)
      setSubtitleTrackUrl('')
    }

    setSelectedFile(null)
    setMediaUrl('')
    setSubtitleTrackVersion(0)
    restoreSavedSession(session)
  }

  const handleSavedSessionDelete = (id: string) => {
    const currentSessionId = currentFileInfo ? createSessionId(currentFileInfo) : null
    const nextSessions = removePersistedSession(id)
    setSavedSessions(nextSessions)

    if (currentSessionId === id) {
      resetCurrentSessionState()
    }
  }

  const handleSavedSessionsClear = () => {
    clearPersistedSessions()
    setSavedSessions([])
    resetCurrentSessionState({ clearLoadedFile: true })
  }

  const handleSavedSessionsLimitChange = (value: string) => {
    const nextLimit = clamp(parseInt(value, 10) || DEFAULT_PERSISTED_SESSIONS_LIMIT, 1, MAX_PERSISTED_SESSIONS_LIMIT)
    setSavedSessionsLimit(nextLimit)
    savePersistedSessionsLimit(nextLimit)
    const nextSessions = trimPersistedSessions(nextLimit)
    setSavedSessions(nextSessions)
  }

  const handleSegmentTextChange = (id: number, value: string) => {
    const nextSegments = segments.map((segment) => (segment.id === id ? { ...segment, text: value } : segment))
    commitEditableSnapshot(buildSnapshotFromSegments(nextSegments, { detectedLanguage, showSegments }))
  }

  const handleSegmentJump = (segment: Segment, options?: { keepTextFocus?: boolean }) => {
    const mediaElement = mediaRef.current
    if (!mediaElement) {
      return
    }

    setActiveSegmentId(segment.id)
    mediaElement.currentTime = Math.max(0, segment.start + 0.01)
    if (!options?.keepTextFocus) {
      mediaElement.focus()
    }
  }

  const handleSegmentSplit = (id: number) => {
    const index = segments.findIndex((segment) => segment.id === id)
    if (index === -1) {
      return
    }

    const segment = segments[index]
    const textarea = segmentTextareaRefs.current[id]
    const cursor = textarea?.selectionStart ?? Math.ceil(segment.text.length / 2)
    const splitIndex = clamp(cursor, 1, Math.max(1, segment.text.length - 1))
    const beforeText = segment.text.slice(0, splitIndex).trim()
    const afterText = segment.text.slice(splitIndex).trim()
    if (!beforeText || !afterText) {
      return
    }

    const duration = Math.max(0.4, segment.end - segment.start)
    const ratio = segment.text.length > 0 ? splitIndex / segment.text.length : 0.5
    const splitTime = clamp(segment.start + duration * ratio, segment.start + 0.2, segment.end - 0.2)
    const updated = [
      ...segments.slice(0, index),
      { ...segment, text: beforeText, end: splitTime },
      { ...segment, text: afterText, start: splitTime },
      ...segments.slice(index + 1),
    ]

    commitEditableSnapshot(buildSnapshotFromSegments(reindexLocalSegments(updated), { detectedLanguage, showSegments }))
  }

  const handleSegmentMergeWithNext = (id: number) => {
    const index = segments.findIndex((segment) => segment.id === id)
    if (index === -1 || index === segments.length - 1) {
      return
    }

    const currentSegment = segments[index]
    const nextSegment = segments[index + 1]
    const mergedText = joinSegmentTexts(currentSegment.text, nextSegment.text)
    const updated = [
      ...segments.slice(0, index),
      {
        ...currentSegment,
        end: nextSegment.end,
        text: mergedText,
      },
      ...segments.slice(index + 2),
    ]

    commitEditableSnapshot(buildSnapshotFromSegments(reindexLocalSegments(updated), { detectedLanguage, showSegments }))
  }

  const handleSegmentDelete = (id: number) => {
    const updated = segments.filter((segment) => segment.id !== id)
    delete segmentTextareaRefs.current[id]
    commitEditableSnapshot(buildSnapshotFromSegments(reindexLocalSegments(updated), { detectedLanguage, showSegments }))
  }

  const mergedPlainText = useMemo(() => plainText, [plainText])

  const outputBaseName = selectedFile ? makeOutputBaseName(selectedFile.name) : 'transcripcion'
  const subtitleLanguageCode = detectedLanguage ?? 'und'
  const hasStickyMediaPreview = Boolean(selectedFile)

  const handleExportTxt = () => {
    downloadTextFile(`${outputBaseName}.txt`, toTxt(segments, mergedPlainText), 'text/plain;charset=utf-8')
  }

  const handleCopy = async (format: 'TXT' | 'SRT' | 'VTT', content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopyMessage(formatTemplate(texts.copiedFormat, { format }))
    } catch {
      setCopyMessage(formatTemplate(texts.copyFailedFormat, { format }))
    }
  }

  const handleCopyText = async () => {
    await handleCopy('TXT', toTxt(segments, mergedPlainText))
  }

  const handleExportSrt = () => {
    downloadTextFile(`${outputBaseName}.srt`, toSrt(segments), 'application/x-subrip;charset=utf-8')
  }

  const handleExportVtt = () => {
    downloadTextFile(`${outputBaseName}.vtt`, toVtt(segments), 'text/vtt;charset=utf-8')
  }

  const handleCopySrt = async () => {
    await handleCopy('SRT', toSrt(segments))
  }

  const handleCopyVtt = async () => {
    await handleCopy('VTT', toVtt(segments))
  }

      return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="hero-topbar">
            <p className="brand">{texts.appName}</p>
            <select
              aria-label={texts.uiLanguage}
              className="ui-language-select"
              value={uiLanguageSetting}
              onChange={(event) => setUiLanguageSetting(event.target.value as UiLanguageSetting)}
            >
              {UI_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <h1>{texts.heroTitle}</h1>
          <p className="lede">{texts.heroSubtitle}</p>
        </div>
        <div className="hero-support-grid">
          <div className="hero-card">
            <div className="picker-row">
              <label className="file-picker">
                <span>{texts.selectMedia}</span>
                <input
                  accept="audio/*,video/*"
                  type="file"
                  onChange={(event) => handleFileChange(event.target.files?.[0] ?? null)}
                />
              </label>
              <label className="file-picker file-picker-secondary">
                <span>{texts.importSubtitles}</span>
                <input
                  accept=".srt,.vtt,text/vtt,application/x-subrip"
                  type="file"
                  onChange={(event) => handleSubtitleImport(event.target.files?.[0] ?? null)}
                />
              </label>
            </div>
            <p className="meta">{fileSummary || texts.localMediaHint}</p>
            <div className="settings-grid">
              <label>
                <span>{texts.model}</span>
                <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
                  {MODEL_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint settings-grid-note">{getModelDescription(modelId, texts)}</p>
            </div>
            <div className="hero-actions">
              <button className="primary-button" disabled={!selectedFile || isTranscribing} onClick={handleTranscribe}>
                {isTranscribing ? texts.transcribing : texts.startTranscription}
              </button>
            </div>
          </div>

          <article className="panel status-panel">
            <div className="panel-heading">
              <h2>{texts.status}</h2>
              {isTranscribing ? (
                <button className="secondary-button status-cancel-button" onClick={handleCancel} type="button">
                  {texts.cancel}
                </button>
              ) : null}
            </div>
            <p>{translateStatus(visibleStatus, texts, uiLanguage)}</p>
            <div className="progress-block" aria-live="polite">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.max(workflowProgress, 2)}%` }} />
              </div>
              <div className="progress-meta">
                <span>{workflowProgress}%</span>
              </div>
            </div>
            {downloadProgress !== null ? (
              <div className="progress-block progress-block-secondary" aria-live="polite">
                <span className="progress-title">{texts.modelDownload}</span>
              <div className="progress-track">
                  <div className="progress-fill progress-fill-secondary" style={{ width: `${Math.max(downloadProgress, 2)}%` }} />
                </div>
                <div className="progress-meta">
                  <span>{downloadProgress}%</span>
                </div>
              </div>
            ) : null}
            <div className="timing-meta">
              <span>{texts.currentTime}: {formatElapsed(elapsedSeconds)}</span>
            </div>
            {errorMessage ? <p className="error-note">{errorMessage}</p> : null}
          </article>
        </div>

        {savedSessions.length > 0 ? (
          <article className="panel saved-sessions-panel">
            <div className="panel-heading">
              <h2>{texts.localStorageTitle}</h2>
              <div className="saved-sessions-toolbar">
                <button
                  className="secondary-button"
                  onClick={() => setIsSavedSessionsExpanded((current) => !current)}
                  type="button"
                >
                  {isSavedSessionsExpanded ? texts.hide : texts.show}
                </button>
                <label className="saved-limit-control">
                  <span>{texts.limit}</span>
                  <select value={savedSessionsLimit} onChange={(event) => handleSavedSessionsLimitChange(event.target.value)}>
                    {Array.from({ length: MAX_PERSISTED_SESSIONS_LIMIT }, (_, index) => index + 1).map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="secondary-button" onClick={handleSavedSessionsClear} type="button">
                  {texts.clearAll}
                </button>
              </div>
            </div>
            <p className="small-note saved-sessions-summary">
              {formatTemplate(texts.savedSummary, { count: String(savedSessions.length), limit: String(savedSessionsLimit), size: formatBytes(savedSessionsSize) })}
            </p>
            {isSavedSessionsExpanded ? (
              <div className="saved-sessions-list">
                {savedSessions.map((session) => (
                  <article
                    className={`saved-session-card ${currentFileInfo && session.fileInfo && sameFileInfo(session.fileInfo, currentFileInfo) ? 'saved-session-card-active' : ''}`}
                    key={session.id}
                  >
                    <div className="saved-session-copy">
                      <strong>{session.fileInfo?.name ?? texts.savedSessionNoFile}</strong>
                      <span className="small-note">
                        {session.fileInfo ? `${formatBytes(session.fileInfo.size)} · ` : ''}
                        {formatSavedAt(session.savedAt, uiLanguage)}
                      </span>
                    </div>
                    <div className="saved-session-actions">
                      <button className="secondary-button" onClick={() => handleSavedSessionRestore(session)} type="button">
                        {texts.recover}
                      </button>
                      <button className="secondary-button" onClick={() => handleSavedSessionDelete(session.id)} type="button">
                        {texts.delete}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
          </article>
        ) : null}
      </section>

      <section className="workspace-grid">
        <article className={`panel preview-panel ${hasStickyMediaPreview ? 'preview-panel-sticky' : ''}`}>
          <div className="panel-heading">
            <h2>{texts.file}</h2>
            <span className="pill">{selectedFile ? (isVideoFile(selectedFile) ? texts.video : texts.audio) : texts.noFile}</span>
          </div>

          {mediaUrl ? (
            isVideoFile(selectedFile!) ? (
              <video
                ref={(element) => {
                  videoRef.current = element
                  mediaRef.current = element
                }}
                className="media-player"
                controls
                src={mediaUrl}
              >
                {subtitleTrackUrl ? (
                  <track
                    key={subtitleTrackVersion}
                    default
                    kind="subtitles"
                    label={texts.transcriptionTrack}
                    src={subtitleTrackUrl}
                    srcLang={subtitleLanguageCode}
                  />
                ) : null}
              </video>
            ) : (
              <audio
                ref={(element) => {
                  mediaRef.current = element
                  videoRef.current = null
                }}
                className="media-player"
                controls
                src={mediaUrl}
              />
            )
          ) : (
            <div className="empty-state">{texts.noMediaLoaded}</div>
          )}
        </article>

        <div className="workspace-main">
          <article className="panel output-panel">
            <div className="panel-heading">
              <h2>{texts.extractedText}</h2>
              <div className="export-actions">
                <div className="export-group">
                  <span className="export-group-title">{texts.saveAs}</span>
                  <div className="export-group-actions">
                    <button disabled={!canExport} onClick={handleExportTxt} type="button">
                      <span aria-hidden="true">↓</span> TXT
                    </button>
                    <button disabled={!canExport} onClick={handleExportSrt} type="button">
                      <span aria-hidden="true">↓</span> SRT
                    </button>
                    <button disabled={!canExport} onClick={handleExportVtt} type="button">
                      <span aria-hidden="true">↓</span> VTT
                    </button>
                  </div>
                </div>
                <div aria-hidden="true" className="export-divider" />
                <div className="export-group">
                  <span className="export-group-title">{texts.copyAs}</span>
                  <div className="export-group-actions">
                    <button disabled={!canExport} onClick={handleCopyText} type="button">
                      <span aria-hidden="true">⧉</span> TXT
                    </button>
                    <button disabled={!canExport} onClick={handleCopySrt} type="button">
                      <span aria-hidden="true">⧉</span> SRT
                    </button>
                    <button disabled={!canExport} onClick={handleCopyVtt} type="button">
                      <span aria-hidden="true">⧉</span> VTT
                    </button>
                  </div>
                </div>
              </div>
            </div>
            {copyMessage ? (
              <div className="status-box copy-feedback" role="status" aria-live="polite">
                <p>{copyMessage}</p>
              </div>
            ) : null}
            <p className="small-note output-hint">{texts.extractedTextHint}</p>

            <textarea
              className="plain-text"
              value={mergedPlainText}
              onChange={(event) =>
                commitEditableSnapshot({
                  detectedLanguage,
                  plainText: event.target.value,
                  segments,
                  showSegments,
                })
              }
              placeholder={texts.plainTextPlaceholder}
            />
          </article>

          <section className="panel transcript-panel">
            <div className="panel-heading">
              <h2>{texts.fragmentsTimed}</h2>
              <div className="transcript-actions">
                <span className="meta">
                  {segments.length > 0 ? formatTemplate(texts.blocksCount, { count: String(segments.length) }) : texts.noBlocks}
                </span>
                <div className="history-actions">
                  <button className="secondary-button" disabled={!canUndo} onClick={handleUndo} type="button">
                    {texts.undo}
                  </button>
                  <button className="secondary-button" disabled={!canRedo} onClick={handleRedo} type="button">
                    {texts.redo}
                  </button>
                </div>
              </div>
            </div>

            {segments.length > 0 ? (
              <div className="segments">
                {segments.map((segment, index) => (
                  <article
                    ref={(element) => {
                      segmentCardRefs.current[segment.id] = element
                    }}
                    className={`segment-card ${selectedFile && isVideoFile(selectedFile) ? 'segment-card-clickable' : ''} ${activeSegmentId === segment.id ? 'segment-card-active' : ''}`}
                    key={segment.id}
                    onClick={() => handleSegmentJump(segment)}
                    tabIndex={-1}
                  >
                    <div className="segment-header">
                      <strong>#{segment.id}</strong>
                      <span>
                        {formatDuration(segment.start)} - {formatDuration(segment.end)}
                      </span>
                    </div>
                    <div className="segment-actions">
                      <button
                        className="secondary-button"
                        onClick={(event) => {
                          event.stopPropagation()
                          handleSegmentSplit(segment.id)
                        }}
                        type="button"
                      >
                        {texts.split}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={index === segments.length - 1}
                        onClick={(event) => {
                          event.stopPropagation()
                          handleSegmentMergeWithNext(segment.id)
                        }}
                        type="button"
                      >
                        {texts.mergeNext}
                      </button>
                      <button
                        className="secondary-button"
                        onClick={(event) => {
                          event.stopPropagation()
                          handleSegmentDelete(segment.id)
                        }}
                        type="button"
                      >
                        {texts.delete}
                      </button>
                    </div>
                    <textarea
                      ref={(element) => {
                        segmentTextareaRefs.current[segment.id] = element
                      }}
                      value={segment.text}
                      onClick={(event) => {
                        event.stopPropagation()
                        handleSegmentJump(segment, { keepTextFocus: true })
                      }}
                      onFocus={() => handleSegmentJump(segment, { keepTextFocus: true })}
                      onChange={(event) => handleSegmentTextChange(segment.id, event.target.value)}
                    />
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">{texts.emptySegments}</div>
            )}
          </section>
        </div>
      </section>

      <footer className="app-footer">
        <p>
          ©{' '}
          <a href="https://bilateria.org" rel="noreferrer" target="_blank">
            Juan José de Haro
          </a>
          {' '}· v{APP_VERSION}
          {' '}· {texts.footerLicensedUnder}{' '}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" rel="noreferrer" target="_blank">
            AGPLv3
          </a>
          {' '}·{' '}
          <a href="https://github.com/jjdeharo/transcribe/issues" rel="noreferrer" target="_blank">
            {texts.feedbackIssues}
          </a>
        </p>
      </footer>
    </main>
  )
}

async function getMediaDuration(file: File): Promise<number> {
  const objectUrl = URL.createObjectURL(file)
  const tagName = isVideoFile(file) ? 'video' : 'audio'
  const mediaElement = document.createElement(tagName)

  mediaElement.preload = 'metadata'
  mediaElement.src = objectUrl

  try {
    const duration = await new Promise<number>((resolve, reject) => {
      mediaElement.onloadedmetadata = () => {
        if (Number.isFinite(mediaElement.duration) && mediaElement.duration > 0) {
          resolve(mediaElement.duration)
          return
        }

        reject(new Error('No se pudo leer la duración del archivo.'))
      }

      mediaElement.onerror = () => {
        reject(new Error('El navegador no pudo cargar los metadatos del archivo.'))
      }
    })

    return duration
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export default App

function createTranscriptionWorker(
  setStatus: (value: string) => void,
  setWorkflowProgress: Dispatch<SetStateAction<number>>,
  setDownloadProgress: Dispatch<SetStateAction<number | null>>,
  pendingResolveRef: MutableRefObject<((value: WorkerSuccess) => void) | null>,
  pendingRejectRef: MutableRefObject<((reason?: unknown) => void) | null>,
): Worker {
  const worker = new Worker(new URL('./workers/transcriptionWorker.ts', import.meta.url), {
    type: 'module',
  })

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data

    if (message.type === 'status') {
      setStatus(message.payload)
      setWorkflowProgress((current) => advanceProgress(current, mapStatusToProgress(message.payload)))
      return
    }

    if (message.type === 'download') {
      let reachedModelLoadPhase = false
      setDownloadProgress((current) => {
        const next = normalizeDownloadProgress(message.payload, current)
        if (next !== null && next >= 100) {
          reachedModelLoadPhase = true
          return null
        }
        return next
      })
      setStatus(reachedModelLoadPhase ? 'Cargando modelo…' : 'Descargando el modelo de transcripción…')
      if (reachedModelLoadPhase) {
        setWorkflowProgress((current) => advanceProgress(current, 68))
      }
      return
    }

    if (message.type === 'chunkProgress') {
      const { completed, total } = message.payload
      const ratio = total > 0 ? completed / total : 0
      setStatus(`Transcribiendo bloque ${completed} de ${total}…`)
      setWorkflowProgress((current) => advanceProgress(current, Math.max(72, Math.min(98, Math.round(72 + ratio * 26)))))
      return
    }

    if (message.type === 'result') {
      setDownloadProgress(null)
      setWorkflowProgress(100)
      pendingResolveRef.current?.(message.payload)
      pendingResolveRef.current = null
      pendingRejectRef.current = null
      return
    }

    if (message.type === 'error') {
      setDownloadProgress(null)
      pendingRejectRef.current?.(new Error(message.payload))
      pendingResolveRef.current = null
      pendingRejectRef.current = null
    }
  }

  return worker
}

function advanceProgress(current: number, next: number): number {
  return Math.max(current, Math.max(0, Math.min(100, Math.round(next))))
}

function normalizeDownloadProgress(
  payload: { progress?: number; status?: string; loaded?: number; total?: number },
  current: number | null,
): number | null {
  if (payload.status === 'progress_total' && typeof payload.loaded === 'number' && typeof payload.total === 'number' && payload.total > 0) {
    const next = Math.round((payload.loaded / payload.total) * 100)
    return advanceProgress(current ?? 0, next)
  }

  if (typeof payload.progress !== 'number' || !Number.isFinite(payload.progress)) {
    return current
  }

  if (payload.progress <= 1) {
    return advanceProgress(current ?? 0, payload.progress * 100)
  }

  return advanceProgress(current ?? 0, payload.progress)
}

function formatElapsed(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds)
  const seconds = safeSeconds % 60
  const totalMinutes = Math.floor(safeSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)

  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

function makeSubtitleTrackUrl(segments: Segment[]): string {
  const blob = new Blob([toVtt(segments)], { type: 'text/vtt;charset=utf-8' })
  return URL.createObjectURL(blob)
}

function mapStatusToProgress(status: string): number {
  const normalized = status.toLowerCase()

  if (normalized.includes('selecciona un archivo')) return 0
  if (normalized.includes('archivo cargado')) return 4
  if (normalized.includes('preparando el archivo')) return 8
  if (normalized.includes('cargando ffmpeg')) return 12
  if (normalized.includes('extrayendo audio')) return 24
  if (normalized.includes('decodificando audio')) return 45
  if (normalized.includes('preparando el modelo')) return 55
  if (normalized.includes('transcribiendo')) return 78
  if (normalized.includes('procesando audio')) return 82
  if (normalized.includes('completada')) return 100

  return 10
}

function loadPersistedSessions(): PersistedSession[] {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw) as { sessions?: unknown; version?: number } & Record<string, unknown>
    if (parsed.version === 3 && Array.isArray(parsed.sessions)) {
      return parsed.sessions
        .map((session, index) => normalizePersistedSession(session, index))
        .filter((session): session is PersistedSession => session !== null)
        .slice(0, MAX_PERSISTED_SESSIONS_LIMIT)
    }

    const legacySession = normalizePersistedSession(parsed, 0)
    return legacySession ? [legacySession] : []
  } catch {
    return []
  }
}

function savePersistedSessions(session: PersistedSession, limit = loadPersistedSessionsLimit()): PersistedSession[] {
  const existingSessions = loadPersistedSessions()
  const matchingSession = session.fileInfo ? findPersistedSessionByFileInfo(existingSessions, session.fileInfo) : null
  const fallbackSessionId = session.id || createSessionId(session.fileInfo, session.savedAt)
  const sessionId = matchingSession?.id ?? fallbackSessionId
  const normalizedSession: PersistedSession = {
    ...session,
    id: sessionId,
    savedAt: Date.now(),
  }
  const dedupedSessions = existingSessions.filter((entry) => entry.id !== normalizedSession.id)
  const nextSessions = [normalizedSession, ...dedupedSessions].slice(0, limit)

  try {
    const payload: PersistedStore = {
      sessions: nextSessions,
      version: 3,
    }
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore persistence failures so editing keeps working even if storage is unavailable.
  }

  return nextSessions
}

function removePersistedSession(id: string): PersistedSession[] {
  const nextSessions = loadPersistedSessions().filter((session) => session.id !== id)

  try {
    const payload: PersistedStore = {
      sessions: nextSessions,
      version: 3,
    }
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage failures.
  }

  return nextSessions
}

function clearPersistedSessions(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
}

function trimPersistedSessions(limit = loadPersistedSessionsLimit()): PersistedSession[] {
  const nextSessions = loadPersistedSessions().slice(0, limit)

  try {
    const payload: PersistedStore = {
      sessions: nextSessions,
      version: 3,
    }
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage failures.
  }

  return nextSessions
}

function loadPersistedSessionsLimit(): number {
  try {
    const raw = window.localStorage.getItem(SESSION_LIMIT_STORAGE_KEY)
    return clamp(parseInt(raw ?? '', 10) || DEFAULT_PERSISTED_SESSIONS_LIMIT, 1, MAX_PERSISTED_SESSIONS_LIMIT)
  } catch {
    return DEFAULT_PERSISTED_SESSIONS_LIMIT
  }
}

function savePersistedSessionsLimit(limit: number): void {
  try {
    window.localStorage.setItem(SESSION_LIMIT_STORAGE_KEY, String(clamp(limit, 1, MAX_PERSISTED_SESSIONS_LIMIT)))
  } catch {
    // Ignore storage failures.
  }
}

function loadUiLanguageSetting(): UiLanguageSetting {
  try {
    const raw = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)
    return isUiLanguageSetting(raw) ? raw : 'auto'
  } catch {
    return 'auto'
  }
}

function saveUiLanguageSetting(setting: UiLanguageSetting): void {
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, setting)
  } catch {
    // Ignore storage failures.
  }
}

function isPersistedSegment(value: unknown): value is Segment {
  if (!value || typeof value !== 'object') {
    return false
  }

  const segment = value as Partial<Segment>
  return (
    typeof segment.id === 'number' &&
    typeof segment.start === 'number' &&
    typeof segment.end === 'number' &&
    typeof segment.text === 'string'
  )
}

function isPersistedFileInfo(value: unknown): value is PersistedFileInfo {
  if (!value || typeof value !== 'object') {
    return false
  }

  const fileInfo = value as Partial<PersistedFileInfo>
  return (
    typeof fileInfo.lastModified === 'number' &&
    typeof fileInfo.name === 'string' &&
    typeof fileInfo.size === 'number' &&
    typeof fileInfo.type === 'string'
  )
}

function normalizePersistedSession(value: unknown, index: number): PersistedSession | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const session = value as Record<string, unknown>
  return {
    detectedLanguage: typeof session.detectedLanguage === 'string' ? session.detectedLanguage : null,
    fileInfo: isPersistedFileInfo(session.fileInfo) ? session.fileInfo : null,
    id: typeof session.id === 'string' ? session.id : createSessionId(isPersistedFileInfo(session.fileInfo) ? session.fileInfo : null, index),
    lastRunSeconds: typeof session.lastRunSeconds === 'number' ? session.lastRunSeconds : null,
    modelId: typeof session.modelId === 'string' ? session.modelId : DEFAULT_MODEL_ID,
    plainText: typeof session.plainText === 'string' ? session.plainText : '',
    savedAt: typeof session.savedAt === 'number' ? session.savedAt : Date.now() - index,
    segments: Array.isArray(session.segments) ? session.segments.filter(isPersistedSegment) : [],
    showSegments: true,
    version: 2,
  }
}

function toPersistedFileInfo(file: File): PersistedFileInfo {
  return {
    lastModified: file.lastModified,
    name: file.name,
    size: file.size,
    type: file.type,
  }
}

function sameFileInfo(left: PersistedFileInfo, right: PersistedFileInfo): boolean {
  return (
    left.lastModified === right.lastModified &&
    left.name === right.name &&
    left.size === right.size &&
    left.type === right.type
  )
}

function findPersistedSessionByFileInfo(
  sessions: PersistedSession[],
  fileInfo: PersistedFileInfo,
): PersistedSession | null {
  return sessions.find((session) => session.fileInfo && sameFileInfo(session.fileInfo, fileInfo)) ?? null
}

function createSessionId(fileInfo: PersistedFileInfo | null, suffix = Date.now()): string {
  if (!fileInfo) {
    return `local-${suffix}`
  }

  return `${fileInfo.name}::${fileInfo.size}::${fileInfo.lastModified}::${fileInfo.type || 'unknown'}`
}

function formatSavedAt(savedAt: number, language: SupportedUiLanguage): string {
  return new Intl.DateTimeFormat(toLocaleCode(language), {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(savedAt)
}

function estimatePersistedSessionsSize(sessions: PersistedSession[], limit: number): number {
  try {
    const encoder = new TextEncoder()
    return encoder.encode(JSON.stringify({ sessions, version: 3, limit })).length
  } catch {
    return 0
  }
}

function resolveUiLanguage(setting: UiLanguageSetting): SupportedUiLanguage {
  if (setting !== 'auto') {
    return setting
  }

  if (typeof navigator === 'undefined') {
    return 'es'
  }

  const preferred = navigator.language.toLowerCase().split('-')[0]
  return isSupportedUiLanguage(preferred) ? preferred : 'es'
}

function isSupportedUiLanguage(value: string): value is SupportedUiLanguage {
  return value === 'es' || value === 'en' || value === 'ca' || value === 'gl' || value === 'eu'
}

function isUiLanguageSetting(value: string | null): value is UiLanguageSetting {
  return value === 'auto' || (typeof value === 'string' && isSupportedUiLanguage(value))
}

function toLocaleCode(language: SupportedUiLanguage): string {
  return language === 'eu' ? 'eu-ES' : `${language}-${language === 'en' ? 'US' : 'ES'}`
}

function formatTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
}

function getModelDescription(modelId: string, texts: typeof UI_STRINGS[SupportedUiLanguage]): string {
  switch (modelId) {
    case 'onnx-community/whisper-tiny':
      return texts.modelTinyDescription
    case 'onnx-community/whisper-small':
      return texts.modelSmallDescription
    case 'onnx-community/whisper-base':
    default:
      return texts.modelBaseDescription
  }
}

function translateStatus(
  status: string,
  texts: typeof UI_STRINGS[SupportedUiLanguage],
  language: SupportedUiLanguage,
): string {
  const exact: Record<string, string> = {
    'Selecciona un archivo de audio o vídeo local para empezar.': {
      es: 'Selecciona un archivo de audio o vídeo local para empezar.',
      en: 'Select a local audio or video file to get started.',
      ca: 'Selecciona un fitxer d’àudio o vídeo local per començar.',
      gl: 'Selecciona un ficheiro de audio ou vídeo local para comezar.',
      eu: 'Hautatu tokiko audio edo bideo fitxategi bat hasteko.',
    }[language],
    'Selecciona un archivo.': {
      es: 'Selecciona un archivo.',
      en: 'Select a file.',
      ca: 'Selecciona un fitxer.',
      gl: 'Selecciona un ficheiro.',
      eu: 'Hautatu fitxategi bat.',
    }[language],
    'Archivo cargado. Listo para transcribir.': {
      es: 'Archivo cargado. Listo para transcribir.',
      en: 'File loaded. Ready to transcribe.',
      ca: 'Fitxer carregat. Llest per transcriure.',
      gl: 'Ficheiro cargado. Listo para transcribir.',
      eu: 'Fitxategia kargatu da. Transkribatzeko prest.',
    }[language],
    'Archivo cargado. Transcripción recuperada del guardado local y sincronizada con el medio.': {
      es: 'Archivo cargado. Transcripción recuperada del guardado local y sincronizada con el medio.',
      en: 'File loaded. Transcription restored from local storage and synced with the media.',
      ca: 'Fitxer carregat. Transcripció recuperada del desament local i sincronitzada amb el mitjà.',
      gl: 'Ficheiro cargado. Transcrición recuperada do gardado local e sincronizada co medio.',
      eu: 'Fitxategia kargatu da. Transkripzioa tokiko gordailutik berreskuratu eta multimediarekin sinkronizatu da.',
    }[language],
    'Sesión restaurada. Vuelve a cargar el archivo si quieres previsualizar o sincronizar con el vídeo.': {
      es: 'Sesión restaurada. Vuelve a cargar el archivo si quieres previsualizar o sincronizar con el vídeo.',
      en: 'Session restored. Reload the file if you want preview or media sync.',
      ca: 'Sessió restaurada. Torna a carregar el fitxer si vols previsualització o sincronització amb el vídeo.',
      gl: 'Sesión restaurada. Volve cargar o ficheiro se queres previsualización ou sincronización co vídeo.',
      eu: 'Saioa leheneratu da. Kargatu berriro fitxategia aurrebista edo bideoarekin sinkronizazioa nahi baduzu.',
    }[language],
    'Transcripción restaurada desde el guardado local.': {
      es: 'Transcripción restaurada desde el guardado local.',
      en: 'Transcription restored from local storage.',
      ca: 'Transcripció restaurada des del desament local.',
      gl: 'Transcrición restaurada desde o gardado local.',
      eu: 'Transkripzioa tokiko gordailutik leheneratu da.',
    }[language],
    'Transcribiendo en el navegador…': texts.transcribing,
    'Descargando el modelo de transcripción…': {
      es: 'Descargando el modelo de transcripción…',
      en: 'Downloading the transcription model…',
      ca: 'Descarregant el model de transcripció…',
      gl: 'Descargando o modelo de transcrición…',
      eu: 'Transkripzio eredua deskargatzen…',
    }[language],
    'Cargando modelo…': {
      es: 'Cargando modelo…',
      en: 'Loading model…',
      ca: 'Carregant model…',
      gl: 'Cargando modelo…',
      eu: 'Eredua kargatzen…',
    }[language],
    'Transcripción cancelada.': {
      es: 'Transcripción cancelada.',
      en: 'Transcription canceled.',
      ca: 'Transcripció cancel·lada.',
      gl: 'Transcrición cancelada.',
      eu: 'Transkripzioa bertan behera utzi da.',
    }[language],
    'La importación de subtítulos no pudo completarse.': {
      es: 'La importación de subtítulos no pudo completarse.',
      en: 'Subtitle import could not be completed.',
      ca: 'La importació de subtítols no s’ha pogut completar.',
      gl: 'A importación de subtítulos non se puido completar.',
      eu: 'Azpitituluen inportazioa ezin izan da osatu.',
    }[language],
    'La transcripción no pudo completarse.': {
      es: 'La transcripción no pudo completarse.',
      en: 'The transcription could not be completed.',
      ca: 'La transcripció no s’ha pogut completar.',
      gl: 'A transcrición non se puido completar.',
      eu: 'Transkripzioa ezin izan da osatu.',
    }[language],
    'Preparando archivo': {
      es: 'Preparando archivo',
      en: 'Preparing file',
      ca: 'Preparant fitxer',
      gl: 'Preparando ficheiro',
      eu: 'Fitxategia prestatzen',
    }[language],
    'Extrayendo y decodificando audio': {
      es: 'Extrayendo y decodificando audio',
      en: 'Extracting and decoding audio',
      ca: 'Extraient i descodificant l’àudio',
      gl: 'Extraendo e decodificando audio',
      eu: 'Audioa ateratzen eta deskodetzen',
    }[language],
    'Cargando modelo': {
      es: 'Cargando modelo',
      en: 'Loading model',
      ca: 'Carregant model',
      gl: 'Cargando modelo',
      eu: 'Eredua kargatzen',
    }[language],
    'Preparando transcripción': {
      es: 'Preparando transcripción',
      en: 'Preparing transcription',
      ca: 'Preparant la transcripció',
      gl: 'Preparando a transcrición',
      eu: 'Transkripzioa prestatzen',
    }[language],
    Transcribiendo: texts.transcribing,
    Terminado: {
      es: 'Terminado',
      en: 'Done',
      ca: 'Acabat',
      gl: 'Rematado',
      eu: 'Amaituta',
    }[language],
    'Listo para empezar': {
      es: 'Listo para empezar',
      en: 'Ready to start',
      ca: 'Llest per començar',
      gl: 'Listo para comezar',
      eu: 'Hasteko prest',
    }[language],
  }

  if (exact[status]) {
    return exact[status]
  }

  const importMatch = status.match(/^Archivo de subtítulos importado\. (\d+) fragmentos disponibles\.$/)
  if (importMatch) {
    const count = importMatch[1]
    return {
      es: `Archivo de subtítulos importado. ${count} fragmentos disponibles.`,
      en: `Subtitle file imported. ${count} segments available.`,
      ca: `Fitxer de subtítols importat. ${count} fragments disponibles.`,
      gl: `Ficheiro de subtítulos importado. ${count} fragmentos dispoñibles.`,
      eu: `Azpititulu fitxategia inportatu da. ${count} zati erabilgarri.`,
    }[language]
  }

  const completedMatch = status.match(/^Transcripción completada\. (\d+) fragmentos detectados\.$/)
  if (completedMatch) {
    const count = completedMatch[1]
    return {
      es: `Transcripción completada. ${count} fragmentos detectados.`,
      en: `Transcription completed. ${count} segments detected.`,
      ca: `Transcripció completada. ${count} fragments detectats.`,
      gl: `Transcrición completada. ${count} fragmentos detectados.`,
      eu: `Transkripzioa osatu da. ${count} zati detektatu dira.`,
    }[language]
  }

  const blockMatch = status.match(/^Transcribiendo bloque (\d+) de (\d+)…$/)
  if (blockMatch) {
    const current = blockMatch[1]
    const total = blockMatch[2]
    return {
      es: `Transcribiendo bloque ${current} de ${total}…`,
      en: `Transcribing block ${current} of ${total}…`,
      ca: `Transcrivint bloc ${current} de ${total}…`,
      gl: `Transcribindo bloque ${current} de ${total}…`,
      eu: `${total} bloketik ${current}. blokea transkribatzen…`,
    }[language]
  }

  return status
}

function isKnownModel(modelId: string): boolean {
  return MODEL_OPTIONS.some((option) => option.id === modelId)
}

function buildSnapshotFromSegments(segments: Segment[], options?: Partial<Omit<EditableSnapshot, 'segments'>>): EditableSnapshot {
  return {
    detectedLanguage: options?.detectedLanguage ?? null,
    plainText: options?.plainText ?? segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n'),
    segments,
    showSegments: options?.showSegments ?? true,
  }
}

function editableSnapshotsEqual(left: EditableSnapshot, right: EditableSnapshot): boolean {
  if (
    left.detectedLanguage !== right.detectedLanguage ||
    left.plainText !== right.plainText ||
    left.showSegments !== right.showSegments ||
    left.segments.length !== right.segments.length
  ) {
    return false
  }

  for (let index = 0; index < left.segments.length; index += 1) {
    const current = left.segments[index]
    const next = right.segments[index]
    if (
      current.id !== next.id ||
      current.start !== next.start ||
      current.end !== next.end ||
      current.text !== next.text
    ) {
      return false
    }
  }

  return true
}

function reindexLocalSegments(segments: Segment[]): Segment[] {
  return segments.map((segment, index) => ({
    ...segment,
    id: index + 1,
  }))
}

function joinSegmentTexts(left: string, right: string): string {
  const leftTrimmed = left.trim()
  const rightTrimmed = right.trim()
  if (!leftTrimmed) return rightTrimmed
  if (!rightTrimmed) return leftTrimmed
  return `${leftTrimmed} ${rightTrimmed}`.trim()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
