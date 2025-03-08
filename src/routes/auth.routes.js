import express from 'express';
import * as authController from '../controllers/auth.controller.js';
import { protect } from '../middleware/auth.middleware.js';

const router = express.Router();

// Standard authentication endpoints
router.post('/login', authController.login);
router.post('/register', authController.register);
router.get('/verify-email', authController.verifyEmail);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/refresh-token', authController.refreshToken);
router.post('/logout', protect, authController.logout);
router.patch('/update-password', protect, authController.updatePassword);

// Google OAuth endpoints
router.get('/google', authController.googleLogin);
router.get('/google/callback', authController.googleCallback);

export default router;
