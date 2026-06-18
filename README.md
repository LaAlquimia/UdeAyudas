# UdeAyudas

> Asistente inteligente para los trámites y procesos universitarios de la **Universidad de Antioquia** (UdeA).

🌐 **Sitio en vivo:** [udeayudas.netlify.app](https://udeayudas.netlify.app)  
🗄️ **Vectorización y web scraping:** [udeaScrape](https://github.com/LaAlquimia/udeaScrape)  
🤖 **LangGraph / backend conversacional:** [LangGraph_UdeAyudas](https://github.com/Marlon0144/LangGraph_UdeAyudas.git)

UdeAyudas es una interfaz web con estética **liquid glass** que ofrece un chatbot con **dos motores seleccionables** especializado en orientar a estudiantes, egresados, docentes y personal administrativo sobre los trámites y procedimientos académicos y administrativos más comunes de la UdeA: matrícula, certificados, homologaciones, calendario académico, becas, grados y más.

**Motores disponibles** (el usuario elige desde un selector en el chat):

- **OpenRouter IA** — multi-modelo genérico (GPT-4o mini, Claude Sonnet, Gemini, DeepSeek, etc.) con un system prompt especializado en UdeA. Necesita `OPENROUTER_API_KEY`.
- **Copiloto UdeA** — backend institucional propio en LangGraph + FastAPI, entrenado sobre el corpus normativo UdeA (matrícula, reglamentos, procedimientos, etc.). Solo texto, sin auth. Apunta por defecto al deploy de Render.

## 🚀 Stack

| Tecnología | Uso |
|---|---|
| [Astro 6](https://astro.build) | Framework web con SSR |
| [OpenRouter](https://openrouter.ai) | Motor de IA multi-modelo (opcional) |
| [FastAPI + LangGraph](https://github.com/Marlon0144/LangGraph_UdeAyudas) | Backend del Copiloto UdeA (motor institucional) |
| [Netlify](https://netlify.com) | Hosting serverless + Functions |
| [Bun](https://bun.sh) | Runtime y package manager |

## 🧞 Comandos

```bash
bun install          # Instalar dependencias
bun run dev          # Servidor de desarrollo (localhost:4321)
bun run build        # Build de producción → dist/
bun run preview      # Vista previa del build
```

## 🔐 Variables de entorno

Crea un archivo `.env` en la raíz (hay un `.env.example` como plantilla):

```env
# Requerido solo si vas a usar el motor "OpenRouter IA"
OPENROUTER_API_KEY=sk-or-...aqui

# URL del Copiloto UdeA (default: deploy de Render, no requiere cambios)
COPILOTO_API_URL=https://copiloto-admin-udea.onrender.com/api/invoke
```

`OPENROUTER_API_KEY` se obtiene en [openrouter.ai/keys](https://openrouter.ai/keys).
`COPILOTO_API_URL` es opcional — solo cámbialo si despliegas el backend LangGraph en local o staging.

## 🌐 Deploy en Netlify

### Opción 1 — Deploy manual

```bash
bun run build
netlify deploy --prod --dir=dist
```

### Opción 2 — Conecta el repo (recomendado)

1. Sube el proyecto a GitHub
2. En [Netlify](https://app.netlify.com): **Add new site → Import from Git**
3. Repositorio → Rama `main`
4. Configuración de build:
   - **Build command:** `bun run build`
   - **Publish directory:** `dist`
5. Añade las variables de entorno que vayas a usar:
   - `OPENROUTER_API_KEY` → tu key de OpenRouter (solo si vas a usar ese motor)
   - `COPILOTO_API_URL` → URL del Copiloto UdeA (opcional; el default ya apunta a Render)
6. ¡Deploy!

## 📁 Estructura

```
src/
├── layouts/Base.astro     # Layout principal (nav, footer, theme)
├── components/            # Secciones del landing (Hero, Rubrica, etc.)
├── pages/
│   ├── index.astro        # Landing page
│   ├── chatbot.astro      # Página del asistente (con selector de motor)
│   └── api/chat.ts        # Endpoint SSR → OpenRouter o Copiloto UdeA
└── styles/global.css      # Estilos globales + glassmorphism
```

## 🎨 Diseño

- **Efecto Glassmorphism** con `backdrop-filter: blur()`
- **Fondo animado** con órbites líquidas
- **Modo oscuro/claro** seleccionable (persistente en localStorage)
- **Tipografía**: Inter (Google Fonts)
- **Totalmente responsive**
