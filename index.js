const express = require('express');
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require("path")


// Iniciando o servidor e o cliente do WhatsApp
const app = express();
const port = process.env.PORT || 8081;
const client = new Client();
const genAI = new GoogleGenerativeAI('AIzaSyAZsyLfd1f5hXpb9PmyheeY5IRbMLsP6VY'); // Substitua pela sua chave de API do Gemini

let qrCodeData = null;

// Conectando ao MongoDB
mongoose.connect('mongodb+srv://albertsousalima:albertlima123@infowpp.pwbav.mongodb.net/?retryWrites=true&w=majority&appName=InfoWpp').then(() => {
    console.log('Conectado ao MongoDB');
}).catch(err => {
    console.log('Erro ao conectar ao MongoDB:', err);
});


// Definindo os modelos Mongoose para armazenar os grupos
const agenciaGroupSchema = new mongoose.Schema({
    clientName: { type: String, required: true },
    groupId: { type: String, required: true }
});
const AgenciaGroup = mongoose.model('AgenciaGroup', agenciaGroupSchema);

const agencyGroupSchema = new mongoose.Schema({
    clientName: { type: String, required: true },
    groupId: { type: String, required: true }
});
const AgencyGroup = mongoose.model('AgencyGroup', agencyGroupSchema);

const messageSchema = new mongoose.Schema({
    groupId: { type: String, required: true },
    messages: [
        {
            sender: { type: String, required: true },
            content: { type: String, required: true },
            timestamp: { type: Date, default: Date.now }
        }
    ]
});
const GroupMessage = mongoose.model('GroupMessage', messageSchema);

// Evento para exibir quando o cliente estiver pronto
client.on('ready', () => {
    console.log('Chat bot pronto para receber chamadas!');
    qrCodeData = null; // Limpa o QR Code após a conexão
});



// Função para buscar o ID do grupo pelo nome
async function getGroupIdByName(groupName) {
    try {
        const chats = await client.getChats(); // Obtém todas as conversas
        const groupChat = chats.find(chat => chat.isGroup && chat.name === groupName);
        return groupChat ? groupChat.id._serialized : null; // Retorna o ID se encontrado
    } catch (error) {
        console.error('Erro ao buscar ID do grupo:', error);
        return null;
    }
}

// Função para processar mensagens com o Gemini (IA)
async function processMessageWithGemini(message) {
    const prompt = `
        Contexto:

        Você é um assistente que intermedeia solicitações entre um cliente e um fornecedor. O cliente faz pedidos relacionados a contas alugadas, e você deve perguntar detalhes como ID e nome das contas. Após obter essas informações, retransmita ao fornecedor e envie a resposta dele ao cliente.

        peça para o cliente uma única mensagem: oq ele deseja, sua conta e id expecificando (Ex: id: 00000 conta: contateste)

        Mensagem do cliente: ${message}
    `;
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
        const response = await model.generateContent(prompt);
        if (response && response.response) {
            return response.response.text().trim();
        } else {
            return 'Desculpe, não consegui processar sua solicitação. Tente novamente mais tarde.';
        }
    } catch (error) {
        console.error('Erro ao processar mensagem no Gemini:', error);
        return 'Houve um erro ao processar sua mensagem. Tente novamente mais tarde.';
    }
}

// Função para armazenar mensagens no banco de dados
async function storeMessage(groupId, sender, content) {
    if (!content || content.trim() === "") {
        console.error("Mensagem vazia, não será armazenada.");
        return; // Não armazene mensagens vazias
    }

    let groupMessages = await GroupMessage.findOne({ groupId });
    if (!groupMessages) {
        groupMessages = new GroupMessage({ groupId, messages: [] });
    }

    groupMessages.messages.push({ sender, content });
    try {
        await groupMessages.save();
        console.log("Mensagem armazenada com sucesso.");
    } catch (error) {
        console.error("Erro ao armazenar a mensagem:", error);
    }
}

// Evento de mensagem recebida
client.on('message', async (message) => {
    const from = message.from;  // ID do grupo de onde a mensagem veio
    const customerMessage = message.body;

    // Armazenar a mensagem recebida
    await storeMessage(from, message.author || from, customerMessage);

    // Verificar se o grupo segue o padrão 'agência - [nome do cliente]'
    const groupTitle = await client.getChatById(from).then(chat => chat.name);
    const match = groupTitle.match(/(agência|agency) - (.+)/);

    if (match) {
        const clientName = match[2];  // Nome do cliente extraído do título do grupo
        console.log(`Grupo detectado para o cliente: ${clientName}`);

        if (match[1] === 'agência') {
            // Verificar se o grupo está armazenado
            let agenciaGroup = await AgenciaGroup.findOne({ clientName });
            if (!agenciaGroup) {
                // Armazenar o grupo no banco de dados
                agenciaGroup = new AgenciaGroup({ clientName, groupId: from });
                await agenciaGroup.save();
                console.log(`Grupo "agência - ${clientName}" armazenado.`);
            }

            // Só processar a IA quando o cliente enviar uma mensagem que contenha ID e nome da conta
            if (customerMessage.trim() !== "") {
                // Verificar se a mensagem contém ID e conta
                const hasIdAndAccount = /id[\s:]*\S+/i.test(customerMessage) && /conta[\s:]*\S+/i.test(customerMessage);
            
                if (hasIdAndAccount) {
                    // Apenas repasse a mensagem para o fornecedor e NÃO processe a IA
                    console.log('Mensagem válida com ID e conta, repassando para o fornecedor sem resposta da IA.');
            
                    const agencyGroup = await AgencyGroup.findOne({ clientName });
                    if (agencyGroup) {
                        try {
                            await client.sendMessage(agencyGroup.groupId, `Solicitação do cliente: ${customerMessage}. Respoda com "resposta ao cliente" no início para indicar sua resposta.`);
                            console.log('Mensagem enviada para o fornecedor.');

                            // Enviar confirmação para o grupo da agência
                            await client.sendMessage(agenciaGroup.groupId, "mensagem enviada para o fornecedor");
                            console.log('Confirmação enviada para o grupo da agência.');
                        } catch (error) {
                            console.error('Erro ao enviar mensagem para o fornecedor:', error);
                        }
                    } else {
                        await client.sendMessage(agenciaGroup.groupId, `No momento não foi possível fazer a solicitação ao fornecedor, tente novamente mais tarde.`);
                        console.error(`Grupo de fornecedor "agency - ${clientName}" não encontrado.`);
                    }
                } else {
                    // Caso a mensagem não contenha ID e conta, acione a IA para gerar uma resposta personalizada
                    console.log('Mensagem não contém ID e nome da conta, chamando IA para gerar resposta personalizada.');
            
                    const prompt = `
                        Contexto:
            
                        Você é um assistente virtual que intermedeia solicitações entre clientes e fornecedores. Quando o cliente envia uma mensagem sem o ID e nome da conta, você deve solicitar esses dados de forma educada e clara. 
            
                        Peça para o cliente enviar em uma única mensagem a solicitação, o ID da conta e a conta (Ex: id: 000000 conta: contaTeste). Explique gentilmente que pode ocorrer um erro se não enviar dessa forma.
                        
                        O cliente enviou a seguinte mensagem: "${customerMessage}". Como você pediria educadamente o ID e o nome da conta para que o processo continue? 
                    `;
            
                    const iaResponse = await processMessageWithGemini(prompt);
                    try {
                        await client.sendMessage(from, iaResponse);
                        console.log('Resposta personalizada da IA enviada para o cliente.');
                    } catch (error) {
                        console.error('Erro ao enviar resposta personalizada para o cliente:', error);
                    }
                }
            }
        } else if (match[1] === 'agency') {
            // Verificar se o grupo "agency" está armazenado
            let agencyGroup = await AgencyGroup.findOne({ clientName });
            if (!agencyGroup) {
                // Armazenar o grupo "agency" no banco de dados sem enviar mensagens
                agencyGroup = new AgencyGroup({ clientName, groupId: from });
                await agencyGroup.save();
                console.log(`Grupo "agency - ${clientName}" armazenado.`);
                return; // Nenhuma mensagem será enviada no momento da criação
            }

            // Processar mensagens recebidas no grupo "agency" somente se já existir
            const agenciaGroup = await AgenciaGroup.findOne({ clientName });
            if (agenciaGroup) {
                try {
                    // Verifica se a mensagem começa com "resposta ao cliente" (case-insensitive)
                    if (customerMessage.trim().toLowerCase().startsWith("resposta ao cliente")) {
                        // Envia a mensagem do fornecedor para o cliente
                        await client.sendMessage(agenciaGroup.groupId, `Resposta do fornecedor: ${customerMessage}`);
                        console.log('Mensagem do fornecedor enviada para o cliente.');
                    } else {
                        console.log('Mensagem do fornecedor ignorada. Não começa com "resposta ao cliente".');
                    }
                } catch (error) {
                    console.error('Erro ao enviar mensagem do fornecedor para o cliente:', error);
                }
            } else {
                console.error(`Grupo "agência - ${clientName}" não encontrado.`);
            }
        }
    } else {
        console.log('Grupo não segue o formato esperado.');
    }
});

// Evento para gerar o QR Code
client.on('qr', qr => {
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Erro ao gerar QR Code:', err);
        } else {
            qrCodeData = url;
        }
    });
});

// Inicia o cliente do WhatsApp
client.initialize();

// Configurando a pasta 'public' como estática
app.use(express.static(path.join(__dirname, 'public')));

// Rota para exibir o QR Code
app.get('/qr', (req, res) => {
    if (qrCodeData) {
        res.send(`<img src="${qrCodeData}" alt="QR Code para login no WhatsApp" />`);
    } else {
        res.send('O cliente já está conectado ou o QR Code ainda não foi gerado. Aguarde');
    }
});

// Página inicial para logar com o qrCode
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

//rota para resposta do ping
// Middleware para habilitar CORS (se necessário)
const cors = require("cors")
app.use(cors());
app.get("/ping", (req, res)=>{
    res.json({ message: "server result => ping!" }); // Responde com JSON
})


// Inicia o servidor Express
app.listen(port, () => {
    console.log(`Servidor rodando na porta: ${port}`);
});