const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const passport = require("passport");
const session = require("express-session");
require("dotenv").config();
require("./models/passport.js"); // Import Passport configuration
const flash = require("express-flash");
const axios = require("axios");
const https = require('https');
const NodeCache = require('node-cache');

// Initialize cache with 5 minute TTL
const cache = new NodeCache({ stdTTL: 300 });

// Create keepAlive agent
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000
});

// Configure axios defaults
axios.defaults.timeout = 15000;
axios.defaults.headers.common['Accept'] = 'application/json';
axios.defaults.headers.common['User-Agent'] = 'MovieDB/1.0';

// Create axios instance with retry logic
const tmdbApi = axios.create({
  baseURL: 'https://api.themoviedb.org/3',
  params: {
    api_key: process.env.TMDB_API_KEY,
    language: 'en-US'
  },
  timeout: 15000,
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'MovieDB/1.0'
  },
  maxRedirects: 3,
  httpsAgent: keepAliveAgent,
  validateStatus: function (status) {
    return status >= 200 && status < 500;
  }
});

// Helper function to get cached data or fetch from API
async function getCachedOrFetch(key, fetchFn) {
  const cachedData = cache.get(key);
  if (cachedData) {
    console.log(`Cache hit for ${key}`);
    return cachedData;
  }

  console.log(`Cache miss for ${key}, fetching from API`);
  const data = await fetchFn();
  cache.set(key, data);
  return data;
}

// Helper function to try multiple endpoints
async function tryEndpoints(endpoints, params = {}) {
  for (const endpoint of endpoints) {
    try {
      const response = await tmdbApi.get(endpoint, { params });
      return response.data;
    } catch (error) {
      console.error(`Failed to fetch from ${endpoint}:`, error.message);
      // Continue to next endpoint if this one fails
    }
  }
  throw new Error('All endpoints failed');
}

// Add retry logic with exponential backoff
tmdbApi.interceptors.response.use(null, async (error) => {
  const config = error.config;
  
  config.retryCount = config.retryCount || 0;
  
  if ((error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED' || error.response?.status === 429) && 
      config.retryCount < 3) {
    
    config.retryCount += 1;
    const delay = 2000 * Math.pow(2, config.retryCount - 1);
    
    console.log(`Retrying request to ${config.url} (attempt ${config.retryCount}) after ${delay}ms delay`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    return tmdbApi(config);
  }
  
  console.error('API Request Failed:', {
    url: config.url,
    method: config.method,
    params: config.params,
    error: {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText
    }
  });
  
  return Promise.reject(error);
});

// Add request interceptor for better error handling
tmdbApi.interceptors.request.use(
  config => {
    // Add timestamp to track request duration
    config.metadata = { startTime: new Date() };
    console.log(`Making request to ${config.url} with params:`, config.params);
    return config;
  },
  error => {
    console.error('Request Error:', error);
    return Promise.reject(error);
  }
);

// Add response interceptor for logging
tmdbApi.interceptors.response.use(
  response => {
    const duration = new Date() - response.config.metadata.startTime;
    console.log(`TMDB API request to ${response.config.url} completed in ${duration}ms`);
    return response;
  },
  error => {
    if (error.config) {
      const duration = new Date() - error.config.metadata.startTime;
      console.error(`TMDB API request to ${error.config.url} failed after ${duration}ms:`, error.message);
    }
    return Promise.reject(error);
  }
);

// Helper function to get user-friendly error message
function getUserFriendlyError(error) {
  if (error.response) {
    switch (error.response.status) {
      case 401:
        return "API key is invalid or expired. Please check your configuration.";
      case 429:
        return "Too many requests. Please try again in a few minutes.";
      case 404:
        return "The requested resource was not found.";
      default:
        return "An error occurred while fetching data. Please try again later.";
    }
  } else if (error.code === 'ECONNABORTED') {
    return "The request took too long to complete. Please check your internet connection and try again.";
  } else if (error.code === 'ECONNRESET') {
    return "Connection was reset. Please check your internet connection and try again.";
  } else {
    return "An unexpected error occurred. Please try again later.";
  }
}

const app = express();
const port = 8000;
const User = require("./models/user.js");
const Review = require("./models/review.js");

// Set up EJS as the view engine
app.set("view engine", "ejs");
app.set("views", "./views");

app.use(flash());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));
app.use(bodyParser.json());

// Session setup (Required for Passport)
app.use(
  session({
    secret: process.env.SESSION_SECRET, // Secret key for session
    resave: false,
    saveUninitialized: false,
  })
);

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

/* 🔹 Place middleware HERE, after session & passport setup */
app.use((req, res, next) => {
  res.locals.user = req.user; // Passport adds `user` object to `req` if logged in
  next();
});

mongoose.connect("mongodb://127.0.0.1:27017/jwtAuth");

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Routes
app.get("/", async (req, res) => {
  try {
    // Fetch featured movies for slideshow
    let featuredMovies = [];
    try {
      featuredMovies = await getCachedOrFetch('featured', async () => {
        const data = await tryEndpoints([
          '/movie/now_playing',
          '/movie/popular',
          '/movie/top_rated'
        ]);
        return data.results.slice(0, 5); // Get top 5 movies for slideshow
      });
    } catch (error) {
      console.error("Error fetching featured movies:", error.message);
    }

    // Fetch trending movies with fallback endpoints
    let trendingMovies = [];
    let trendingError = null;
    try {
      trendingMovies = await getCachedOrFetch('trending', async () => {
        const data = await tryEndpoints([
          '/trending/movie/week',
          '/movie/popular',
          '/movie/top_rated'
        ]);
        return data.results;
      });
    } catch (error) {
      console.error("Error fetching trending movies:", error.message);
      trendingError = getUserFriendlyError(error);
    }

    // Fetch popular movies with fallback endpoints
    let popularMovies = [];
    let popularError = null;
    try {
      popularMovies = await getCachedOrFetch('popular', async () => {
        const data = await tryEndpoints([
          '/movie/popular',
          '/movie/top_rated',
          '/trending/movie/week'
        ]);
        return data.results;
      });
    } catch (error) {
      console.error("Error fetching popular movies:", error.message);
      popularError = getUserFriendlyError(error);
    }

    // Fetch recent reviews
    const recentReviews = await Review.find()
      .populate('user', 'username name')
      .sort({ createdAt: -1 })
      .limit(5);

    res.render("home", {
      featuredMovies,
      trendingMovies,
      popularMovies,
      recentReviews,
      trendingError,
      popularError,
      messages: req.flash()
    });
  } catch (error) {
    console.error("Home page error:", error);
    req.flash("error", getUserFriendlyError(error));
    res.render("home", {
      featuredMovies: [],
      trendingMovies: [],
      popularMovies: [],
      recentReviews: [],
      trendingError: getUserFriendlyError(error),
      popularError: getUserFriendlyError(error),
      messages: req.flash()
    });
  }
});

app.get("/login", (req, res) => {
  res.render("login.ejs", { messages: req.flash() });
});


app.get("/signup", (req, res) => {
  res.render("signup.ejs", { messages: req.flash() });
});

// LOGIN with Passport.js
app.post("/login", (req, res, next) => {
  passport.authenticate("local", (err, user, info) => {
      if (err) {
          return next(err);
      }
      if (!user) {
          req.flash("error", "Invalid username or password"); // Flash error on failure
          return res.redirect("/login");
      }
      req.logIn(user, (err) => {
          if (err) {
              return next(err);
          }
          req.flash("success", "Logged in successfully!"); // Flash success on success
          return res.redirect("/");
      });
  })(req, res, next);
});


// Logout Route
app.get("/logout", (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: "Logout failed" });
    }
    res.redirect("/");
  });
});

// Signup Route
app.post("/signup", async (req, res) => {
  const { name, username, password } = req.body;

  try {
    // Check if user already exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      req.flash("error", "Username already exists! Try another.");
      return res.redirect("/signup");
    }

    // Create new user
    const newUser = new User({ name, username, password });
    await newUser.save();

    req.flash("success", "Account created! You can now login.");
    res.redirect("/login");
  } catch (error) {
    console.error("Signup error:", error);
    req.flash("error", "Something went wrong. Please try again.");
    res.redirect("/signup");
  }
});

// Middleware to check if user is logged in
function isLoggedIn(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect("/login");
}

// Profile route
app.get('/profile/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username });
        if (!user) {
            return res.status(404).render('error', { message: 'User not found' });
        }

        // Get user's reviews
        const reviews = await Review.find({ user: user._id })
            .sort({ createdAt: -1 })
            .limit(10);

        // Get user's watchlist and watched movies
        const watchlist = user.watchlist || [];
        const watchedMovies = user.watchedMovies || [];

        res.render('profile', {
            user,
            reviews,
            watchlist: watchlist,
            watched: watchedMovies,
            currentUser: req.user,
            messages: req.flash()
        });
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).render('error', { 
            message: 'Error loading profile',
            error: error.message
        });
    }
});

// Profile edit route
app.get("/profile/:username/edit", isLoggedIn, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    
    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/");
    }

    // Check if the current user is editing their own profile
    if (req.user._id.toString() !== user._id.toString()) {
      req.flash("error", "You can only edit your own profile");
      return res.redirect(`/profile/${user.username}`);
    }

    res.render("profile-edit", { 
      user,
      messages: req.flash()
    });
  } catch (error) {
    console.error("Profile edit error:", error);
    req.flash("error", "Error loading profile edit page");
    res.redirect("/");
  }
});

// Update profile route
app.post("/profile/:username/edit", isLoggedIn, async (req, res) => {
  try {
    const { name, currentPassword, newPassword } = req.body;
    const user = await User.findOne({ username: req.params.username });

    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/");
    }

    // Check if the current user is editing their own profile
    if (req.user._id.toString() !== user._id.toString()) {
      req.flash("error", "You can only edit your own profile");
      return res.redirect(`/profile/${user.username}`);
    }

    // Update name
    user.name = name;

    // Update password if provided
    if (currentPassword && newPassword) {
      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        req.flash("error", "Current password is incorrect");
        return res.redirect(`/profile/${user.username}/edit`);
      }
      user.password = newPassword;
    }

    await user.save();
    req.flash("success", "Profile updated successfully");
    res.redirect(`/profile/${user.username}`);
  } catch (error) {
    console.error("Profile update error:", error);
    req.flash("error", "Error updating profile");
    res.redirect(`/profile/${req.params.username}/edit`);
  }
});

// Delete account route
app.post("/profile/:username/delete", isLoggedIn, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });

    if (!user) {
      req.flash("error", "User not found");
      return res.redirect("/");
    }

    // Check if the current user is deleting their own account
    if (req.user._id.toString() !== user._id.toString()) {
      req.flash("error", "You can only delete your own account");
      return res.redirect(`/profile/${user.username}`);
    }

    // Delete user's reviews
    await Review.deleteMany({ user: user._id });

    // Delete user account
    await User.findByIdAndDelete(user._id);

    // Logout the user
    req.logout((err) => {
      if (err) {
        return next(err);
      }
      req.flash("success", "Account deleted successfully");
      res.redirect("/");
    });
  } catch (error) {
    console.error("Account deletion error:", error);
    req.flash("error", "Error deleting account");
    res.redirect(`/profile/${req.params.username}`);
  }
});

// Movie detail route
app.get("/movie/:id", async (req, res) => {
  try {
    const movieId = req.params.id;
    
    // Fetch movie details, credits, and similar movies in parallel
    let movie, credits, similarMovies, trailers;
    
    try {
      const [movieResponse, creditsResponse, similarResponse, videosResponse] = await Promise.all([
        tmdbApi.get(`/movie/${movieId}`),
        tmdbApi.get(`/movie/${movieId}/credits`),
        tmdbApi.get(`/movie/${movieId}/similar`),
        tmdbApi.get(`/movie/${movieId}/videos`)
      ]);

      movie = movieResponse.data;
      credits = creditsResponse.data;
      similarMovies = similarResponse.data.results.slice(0, 4);
      trailers = videosResponse.data.results.filter(video => video.type === "Trailer");
    } catch (error) {
      console.error("Error fetching movie data:", error);
      req.flash("error", "Error loading movie details. Please try again later.");
      return res.redirect("/");
    }

    // Fetch reviews from database
    let reviews = [];
    try {
      reviews = await Review.find({ movieId })
        .populate('user', 'username name')
        .sort({ createdAt: -1 });
    } catch (error) {
      console.error("Error fetching reviews:", error);
      // Continue without reviews if there's an error
    }

    // Get user's watchlist and watched status if logged in
    let userStatus = {
      inWatchlist: false,
      watched: false
    };

    if (req.user) {
      try {
        const user = await User.findById(req.user._id);
        if (user) {
          userStatus = {
            inWatchlist: user.watchlist.some(movie => movie.movieId === movieId),
            watched: user.watchedMovies.some(movie => movie.movieId === movieId)
          };
        }
      } catch (error) {
        console.error("Error fetching user status:", error);
        // Continue with default userStatus if there's an error
      }
    }

    // Ensure all required data is available
    if (!movie) {
      req.flash("error", "Movie not found");
      return res.redirect("/");
    }

    res.render("movie-detail", {
      movie,
      credits: credits || { cast: [], crew: [] },
      similarMovies: similarMovies || [],
      trailers: trailers || [],
      reviews,
      user: req.user,
      userStatus,
      messages: req.flash()
    });
  } catch (error) {
    console.error("Movie detail error:", error);
    req.flash("error", getUserFriendlyError(error));
    res.redirect("/");
  }
});

// Add review route
app.post("/movie/:id/review", isLoggedIn, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const movieId = req.params.id;

    // Fetch movie details from TMDB for the title
    const movieResponse = await axios.get(
      `https://api.themoviedb.org/3/movie/${movieId}?api_key=${process.env.TMDB_API_KEY}`
    );
    const movie = movieResponse.data;

    const review = new Review({
      user: req.user._id,
      movieId,
      movieTitle: movie.title,
      rating,
      comment
    });

    await review.save();
    req.flash("success", "Review added successfully!");
    res.redirect(`/movie/${movieId}`);
  } catch (error) {
    console.error("Add review error:", error);
    req.flash("error", "Error adding review");
    res.redirect(`/movie/${req.params.id}`);
  }
});

// Add to watchlist route
app.post("/movie/:id/watchlist", isLoggedIn, async (req, res) => {
  try {
    const movieId = req.params.id;
    const movie = await tmdbApi.get(`/movie/${movieId}`);
    
    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { 
        watchlist: {
          movieId: movieId,
          movieTitle: movie.data.title,
          posterPath: movie.data.poster_path,
          addedAt: new Date()
        }
      }
    });

    req.flash("success", "Added to watchlist!");
    res.redirect(`/movie/${movieId}`);
  } catch (error) {
    console.error("Watchlist error:", error);
    req.flash("error", "Error adding to watchlist");
    res.redirect(`/movie/${req.params.id}`);
  }
});

// Mark as watched route
app.post("/movie/:id/watched", isLoggedIn, async (req, res) => {
  try {
    const movieId = req.params.id;
    const movie = await tmdbApi.get(`/movie/${movieId}`);
    
    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { 
        watchedMovies: {
          movieId: movieId,
          movieTitle: movie.data.title,
          posterPath: movie.data.poster_path,
          watchedAt: new Date()
        }
      },
      $pull: { watchlist: { movieId: movieId } }
    });

    req.flash("success", "Marked as watched!");
    res.redirect(`/movie/${movieId}`);
  } catch (error) {
    console.error("Mark watched error:", error);
    req.flash("error", "Error marking as watched");
    res.redirect(`/movie/${req.params.id}`);
  }
});

// Search route with caching
app.get("/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      return res.render("search", { movies: [], query: "", error: null });
    }

    let movies = [];
    let error = null;
    try {
      movies = await getCachedOrFetch(`search_${query}`, async () => {
        const response = await tmdbApi.get('/search/movie', {
          params: { query }
        });
        return response.data.results;
      });
    } catch (error) {
      console.error("Search API error:", error.message);
      error = getUserFriendlyError(error);
    }

    res.render("search", {
      movies: movies,
      query: query,
      error: error
    });
  } catch (error) {
    console.error("Search error:", error);
    req.flash("error", getUserFriendlyError(error));
    res.render("search", { 
      movies: [], 
      query: req.query.q,
      error: getUserFriendlyError(error)
    });
  }
});

// Add test route to verify API key
app.get("/test-api", async (req, res) => {
  try {
    console.log("Testing TMDB API with key:", process.env.TMDB_API_KEY);
    
    const response = await tmdbApi.get('/configuration');
    console.log("API Response:", response.status, response.statusText);
    
    res.json({
      status: "success",
      message: "API key is valid",
      details: {
        status: response.status,
        statusText: response.statusText,
        baseUrl: response.data.images?.base_url
      }
    });
  } catch (error) {
    console.error("API Test Error:", {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText
    });
    
    res.status(500).json({
      status: "error",
      message: "API key may be invalid or expired",
      error: {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        statusText: error.response?.statusText
      }
    });
  }
});

// Edit review form route
app.get("/movie/:movieId/review/:reviewId/edit", isLoggedIn, async (req, res) => {
  try {
    const review = await Review.findById(req.params.reviewId);
    if (!review) {
      req.flash("error", "Review not found");
      return res.redirect(`/movie/${req.params.movieId}`);
    }
    // Only allow the author to edit
    if (review.user.toString() !== req.user._id.toString()) {
      req.flash("error", "You can only edit your own review");
      return res.redirect(`/movie/${req.params.movieId}`);
    }
    res.render("review-edit", { review, movieId: req.params.movieId, messages: req.flash() });
  } catch (error) {
    console.error("Edit review form error:", error);
    req.flash("error", "Error loading review edit form");
    res.redirect(`/movie/${req.params.movieId}`);
  }
});

// Update review route
app.post("/movie/:movieId/review/:reviewId/edit", isLoggedIn, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    console.log('Received rating:', rating, 'type:', typeof rating);
    
    const review = await Review.findById(req.params.reviewId);
    if (!review) {
      req.flash("error", "Review not found");
      return res.redirect(`/movie/${req.params.movieId}`);
    }
    // Only allow the author to update
    if (review.user.toString() !== req.user._id.toString()) {
      req.flash("error", "You can only edit your own review");
      return res.redirect(`/movie/${req.params.movieId}`);
    }
    
    const newRating = Number(rating);
    console.log('Converting rating to number:', newRating, 'type:', typeof newRating);
    
    review.rating = newRating;
    review.comment = comment;
    review.updatedAt = new Date();
    
    console.log('Saving review with rating:', review.rating);
    await review.save();
    console.log('Review saved successfully');
    
    req.flash("success", "Review updated successfully!");
    res.redirect(`/movie/${req.params.movieId}`);
  } catch (error) {
    console.error("Update review error:", error);
    req.flash("error", "Error updating review");
    res.redirect(`/movie/${req.params.movieId}`);
  }
});

