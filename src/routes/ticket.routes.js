'use strict';

const express = require('express');
const { sortTicket, health } = require('../controllers/ticket.controller');

const router = express.Router();

router.get('/health', health);
router.post('/sort-ticket', sortTicket);

module.exports = router;
