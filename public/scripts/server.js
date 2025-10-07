const express = require("express");
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const morgan = require("morgan");

// Configuração inicial
const app = express();
const PORT = process.env.PORT || 3000;
const API_REQUEST_LIMIT = process.env.API_LIMIT || 100; // Limite de requisições por hora

// Verificação da chave de API
if (!process.env.GOOGLE_GEMINI_API_KEY) {
    console.error("ERRO: Chave de API do Gemini não encontrada!");
    console.error("Por favor, defina GOOGLE_GEMINI_API_KEY no arquivo .env");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

// Middlewares
app.use(helmet());
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST']
}));
app.use(morgan('dev'));
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: API_REQUEST_LIMIT,
    message: {
        success: false,
        error: "Limite de requisições excedido. Tente novamente mais tarde."
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Rotas estáticas
app.use(express.static("public", { 
    maxAge: "1d",
    setHeaders: (res, path) => {
        if (path.endsWith(".css") || path.endsWith(".js")) {
            res.setHeader("Cache-Control", "public, max-age=31536000");
        }
    }
}));

// Rota de chat com IA
app.post("/api/chat", limiter, async (req, res) => {
    try {
        const { message, chatHistory = [] } = req.body;
        
        // Validação robusta
        if (!message || typeof message !== "string" || message.trim().length < 5) {
            return res.status(400).json({ 
                success: false,
                error: "Mensagem inválida. Forneça um texto com pelo menos 5 caracteres."
            });
        }

        // Configuração do modelo com fallback
        const modelName = process.env.GEMINI_MODEL || "gemini-pro";
        const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: `
                Você é um especialista em hardware chamado HardIA. Siga estritamente:
                
                1. Idioma: Português brasileiro
                2. Formato: Use Markdown para estruturar a resposta.
                   - **Título de Compatibilidade:** Comece com "✅ Compatível" ou "❌ Incompatível".
                   - **Tabela Comparativa:** Crie uma tabela Markdown comparando "Requisito Mínimo" com "Seu Hardware".
                   - **Análise Detalhada:** Explique os pontos fortes e fracos da sua configuração.
                   - **Recomendações de Melhorias:** Use uma lista com bullet points para sugerir upgrades ou otimizações (se aplicável).
                   - **Nota:** Finalize com uma nota de 1-10 sobre a compatibilidade geral.
                
                3. Estilo: Técnico, mas acessível. Use emojis para ênfase.
                
                Exemplo de tabela:
                | Componente | Requisito Mínimo | Seu Hardware |
                |---|---|---|
                | CPU | Intel Core i5 | Intel Core i3 |
                
                Dados do usuário para análise: ${message}
            `,
        });

        // Configuração do chat com histórico
        const chat = model.startChat({
            history: chatHistory.map(msg => ({
                role: msg.role,
                parts: [{ text: msg.content }]
            })),
            generationConfig: { 
                maxOutputTokens: parseInt(process.env.MAX_TOKENS) || 1000,
                temperature: 0.7,
                topP: 0.9,
                topK: 40
            },
            safetySettings: [
                {
                    category: "HARM_CATEGORY_HARASSMENT",
                    threshold: "BLOCK_NONE"
                },
                {
                    category: "HARM_CATEGORY_HATE_SPEECH",
                    threshold: "BLOCK_NONE"
                }
            ]
        });

        // Envio da mensagem com timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

        const result = await Promise.race([
            chat.sendMessage(message, { signal: controller.signal }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error("Timeout na resposta da API")), 15000)
            )
        ]);
        
        clearTimeout(timeout);

        if (!result?.response) {
            throw new Error("Resposta inválida da API");
        }

        const responseText = result.response.text();
        
        res.json({ 
            success: true,
            data: {
                response: responseText,
                timestamp: new Date().toISOString(),
                model: modelName,
                tokensUsed: result.response.usageMetadata?.totalTokenCount || "N/A"
            }
        });
        
    } catch (error) {
        console.error("Erro no endpoint /api/chat:", error);
        
        const statusCode = error.message.includes("Timeout") ? 504 
                         : error.message.includes("invalid") ? 400 
                         : 500;
        
        res.status(statusCode).json({ 
            success: false,
            error: error.message.includes("Timeout") 
                ? "Tempo de resposta excedido. Tente novamente." 
                : "Erro ao processar sua solicitação. Por favor, tente novamente.",
            details: process.env.NODE_ENV === "development" ? error.message : undefined
        });
    }
});

// Rotas adicionais
app.get("/api/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        version: "1.1.0",
        environment: process.env.NODE_ENV || "development",
        limits: {
            requestsPerHour: API_REQUEST_LIMIT,
            maxTokens: process.env.MAX_TOKENS || 1000
        }
    });
});

// Tratamento de erros global
app.use((err, req, res, next) => {
    console.error(`[${new Date().toISOString()}] Erro:`, err.stack);
    
    res.status(500).json({ 
        success: false,
        error: "Erro interno do servidor",
        requestId: req.id,
        ...(process.env.NODE_ENV === "development" && { stack: err.stack })
    });
});

// Inicialização do servidor
const server = app.listen(PORT, () => {
    console.log(`🟢 Servidor HardIA rodando na porta ${PORT}`);
    console.log(`🔧 Ambiente: ${process.env.NODE_ENV || "development"}`);
    console.log(`🤖 Modelo Gemini: ${process.env.GEMINI_MODEL || "gemini-pro"}`);
});

// Tratamento de encerramento gracioso
process.on("SIGTERM", () => {
    console.log("🛑 Recebido SIGTERM. Encerrando servidor...");
    server.close(() => {
        console.log("🔴 Servidor encerrado");
        process.exit(0);
    });
});

process.on("SIGINT", () => {
    console.log("🛑 Recebido SIGINT. Encerrando servidor...");
    server.close(() => {
        console.log("🔴 Servidor encerrado");
        process.exit(0);
    });
});