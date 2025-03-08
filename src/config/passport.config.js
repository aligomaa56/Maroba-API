import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { authService } from '../services/auth.service.js';
import { AppError } from '../middleware/error.middleware.js';

const configurePassport = () => {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL,
    scope: ['profile', 'email'],
    passReqToCallback: true
  }, async (req, accessToken, refreshToken, profile, done) => {
    try {
      // Validate profile structure before processing
      if (!profile?.emails?.[0]?.value) {
        throw new AppError(400, 'Invalid Google profile - email missing');
      }
      // Process through the service layer
      const result = await authService.handleGoogleLogin(profile);
      // Return result directly (stateless: tokens are sent to the client)
      done(null, result);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      done(new AppError(statusCode, error.message), null);
    }
  }));
};

export default configurePassport;
