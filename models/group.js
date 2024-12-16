const mongoose = require('mongoose');

// Definindo o esquema para armazenar os grupos
const clientGroupsSchema = new mongoose.Schema({
    clientName: { type: String, required: true },
    agenciaGroup: { type: String, required: true },  // ID do grupo "agência"
    agencyGroup: { type: String, required: true }    // ID do grupo "agency"
});

// Criando o modelo com o nome de 'ClientGroup'
const ClientGroup = mongoose.model('ClientGroup', clientGroupsSchema);

module.exports = ClientGroup;