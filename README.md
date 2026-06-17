# NeuralSync AI

> Agente de inteligencia artificial autónomo — Deploy Hackathon 2026

Proyecto participante en la **Deploy Hackaton**. Una interfaz moderna con estética **liquid glass** que integra un chatbot potenciado por **OpenRouter AI**.

## 🚀 Stack

| Tecnología | Uso |
|---|---|
| [Astro 6](https://astro.build) | Framework web con SSR |
| [OpenRouter](https://openrouter.ai) | API multi-modelo de IA |
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

Crea un archivo `.env` en la raíz:

```env
OPENROUTER_API_KEY=sk-or-v1-tu-key-aqui
```

Obtén tu API key en [openrouter.ai/keys](https://openrouter.ai/keys).

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
5. Añade la variable de entorno:
   - `OPENROUTER_API_KEY` → tu key de OpenRouter
6. ¡Deploy!

## 📁 Estructura

```
src/
├── layouts/Layout.astro    # Layout principal (nav, footer, theme)
├── components/
│   ├── GlassCard.astro     # Tarjeta con efecto glass
│   ├── Hero.astro          # Hero del landing
│   ├── FeatureCard.astro   # Card de características
│   ├── ThemeToggle.astro   # Alternar dark/light mode
│   └── ChatBot.astro       # Cliente del chatbot
├── pages/
│   ├── index.astro         # Landing page
│   ├── chatbot.astro       # Página del chatbot
│   └── api/chat.ts         # Endpoint SSR → OpenRouter
└── styles/global.css       # Estilos globales + glassmorphism
```

## 🎨 Diseño

- **Efecto Glassmorphism** con `backdrop-filter: blur()`
- **Fondo animado** con órbites líquidas
- **Modo oscuro/claro** seleccionable (persistente en localStorage)
- **Tipografía**: Inter (Google Fonts)
- **Totalmente responsive**
