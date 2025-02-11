// import { v2 as cloudinary } from 'cloudinary';
// import { env } from './env.config';

// export const cloudinaryConfig = async (): Promise<void> => {
//     try {
//         cloudinary.config({
//             cloud_name: env.CLOUDINARY_CLOUD_NAME,
//             api_key: env.CLOUDINARY_API_KEY,
//             api_secret: env.CLOUDINARY_API_SECRET
//         });

//         // Verify credentials
//         await cloudinary.api.ping();
//         console.log('Cloudinary Connected');

//     } catch (error) {
//         console.error('Cloudinary Configuration Error:', error);
//         throw error;
//     }
// };

// export default cloudinary;
