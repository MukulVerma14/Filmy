const mongoose = require('mongoose');
const Review = require('./models/review');

// Connect to MongoDB
mongoose.connect('mongodb://127.0.0.1:27017/jwtAuth')
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

function mapToFiveStar(oldRating) {
  // Map 1-2 -> 1, 3-4 -> 2, 5-6 -> 3, 7-8 -> 4, 9-10 -> 5
  if (oldRating <= 2) return 1;
  if (oldRating <= 4) return 2;
  if (oldRating <= 6) return 3;
  if (oldRating <= 8) return 4;
  return 5;
}

async function updateRatings() {
  try {
    // Find all reviews
    const reviews = await Review.find({});
    console.log(`Found ${reviews.length} reviews to update`);

    // Update each review
    for (const review of reviews) {
      const oldRating = review.rating;
      const newRating = mapToFiveStar(oldRating);
      if (oldRating !== newRating) {
        review.rating = newRating;
        await review.save();
        console.log(`Updated review ${review._id}: ${oldRating} -> ${newRating}`);
      }
    }

    console.log('All reviews updated successfully');
  } catch (error) {
    console.error('Error updating reviews:', error);
  } finally {
    // Close the database connection
    mongoose.connection.close();
  }
}

// Run the update
updateRatings(); 