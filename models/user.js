const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    watchlist: [{ 
        movieId: String,
        movieTitle: String,
        posterPath: String,
        addedAt: { type: Date, default: Date.now }
    }],
    watchedMovies: [{
        movieId: String,
        movieTitle: String,
        posterPath: String,
        watchedAt: { type: Date, default: Date.now }
    }]
});

// Hash password before saving
UserSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Compare passwords (for login)
UserSchema.methods.comparePassword = async function (enteredPassword) {
    return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("User", UserSchema);
