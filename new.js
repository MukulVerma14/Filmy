const axios = require('axios');

// Your TMDb API key
const apiKey = 'b80cec0d063564355c42151883ec5ab3';

// Movie title you want to search for
const movieTitle = 'shutter island';

// Construct the URL with the search query
const url = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(movieTitle)}&language=en-US&page=1`;

axios.get(url)
  .then(response => {
    const movies = response.data.results;
    if (movies.length > 0) {
      movies.forEach(movie => {
        console.log(`Title: ${movie.title}`);
        console.log(`Release Date: ${movie.release_date}`);
        console.log(`Overview: ${movie.overview}`);
        console.log(`Poster: https://image.tmdb.org/t/p/w500${movie.poster_path}`);
        console.log('------------------------');
      });
    } else {
      console.log("No results found for this movie.");
    }
  })
  .catch(error => {
    console.error("Error fetching data:", error);
  });
