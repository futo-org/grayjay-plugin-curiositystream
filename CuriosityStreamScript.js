/**
 * Curiosity Stream Plugin for Grayjay
 * 
 * This plugin enables browsing, searching, and viewing Curiosity Stream content.
 * It provides access to categories, media items, and collections.
 */

// ---------------------- Constants ----------------------

const PLATFORM = 'CuriosityStream';
const URLS = {
    BASE: 'https://www.curiositystream.com',
    API_V1: 'https://api.curiositystream.com/v1',
    API_V2: 'https://api.curiositystream.com/v2',
    MISSING_IMG: 'https://cdn.curiositystream.com/missing.png'
};

// Regular expressions for URL matching
const REGEX = {
    CONTENT_URL: /^https:\/\/(?:www\.)?curiositystream\.com\/(?:title|video|media|documentary|episode)\/(\d+)\/?/,
    CATEGORY_URL: /^https:\/\/(?:www\.)?curiositystream\.com\/categories\/([a-zA-Z0-9_-]+)\/?/,
    SERIES_URL: /^https:\/\/(?:www\.)?curiositystream\.com\/series\/(\d+)\/?/,
    // Channel URL can be either a category or a series
    CHANNEL_URL: /^https:\/\/(?:www\.)?curiositystream\.com\/(?:categories\/([a-zA-Z0-9_-]+)|series\/(\d+))\/?/
};

// Default HTTP headers
const DEFAULT_HEADERS = {
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36'
};

// API settings
const API = {
    VIDEOS_PER_PAGE: 10
};

// Plugin state
let config = {};
let state = {
    buildId: '',
    has_subscription: false,
    categories: {},
    collections: {} // Cache for collection data
};
let settings = {};

// ====================== PLUGIN ENTRY POINTS ======================

/**
 * Initialize the plugin with configuration
 * @param {Object} conf - Plugin configuration
 * @param {Object} setting - User settings
 * @param {string} saveStateStr - Saved state from previous sessions
 */
source.enable = function(conf, setting, saveStateStr) {
    config = conf;
    settings = setting;
    
    if (saveStateStr) {
        try {
            state = JSON.parse(saveStateStr);
            // Ensure collections object exists
            if (!state.collections) {
                state.collections = {};
            }
        } catch (e) {
            log(e);
            bridge.log('Failed to restore state');
        }
    } else {
        loadInitialState();
    }
};

/**
 * Save the current plugin state
 * @returns {string} State data as JSON string
 */
source.saveState = () => {
    return JSON.stringify(state);
};

/**
 * Get home page content
 * @returns {ContentPager} Paged results for home page
 */
source.getHome = function() {
    const result = fetchContentDataWithCollections({
        url: `${URLS.API_V1}/media?collections=true&limit=${API.VIDEOS_PER_PAGE}`
    });
    
    return new CuriosityStreamHomePager(
        result.items,
        result.hasMore,
        { page: 1 }
    );
};

/**
 * Check if a URL is a Curiosity Stream content page
 * @param {string} url - URL to check
 * @returns {boolean} True if URL points to content
 */
source.isContentDetailsUrl = function(url) {
    return REGEX.CONTENT_URL.test(url);
};

/**
 * Get detailed information for content
 * @param {string} url - Content URL
 * @returns {PlatformVideoDetails} Video details
 */
source.getContentDetails = function(url) {
    // Extract content ID from the URL
    const match = url.match(REGEX.CONTENT_URL);
    if (!match) {
        throw new ScriptException('Invalid Curiosity Stream URL');
    }
    
    const contentId = match[1];
    
    // Fetch media details
    const isLoggedIn = bridge.isLoggedIn();
    const detailsResponse = fetchMediaDetails(contentId, isLoggedIn);
    
    if (!detailsResponse.media) {
        throw new ScriptException('Content not found');
    }
    
    // If the media is part of a collection, fetch collection details
    const media = detailsResponse.media;
    let collection = null;
    
    if (media.collection_id) {
        try {
            collection = fetchCollectionDetails(media.collection_id);
            // Cache the collection for future use
            if (collection) {
                state.collections[media.collection_id] = collection;
            }
        } catch (e) {
            log(`Failed to fetch collection details: ${e.message}`);
        }
    }
    
    return createVideoDetails(media, collection);
};

/**
 * Check if a URL is a Curiosity Stream channel
 * @param {string} url - URL to check
 * @returns {boolean} True if URL points to a channel
 */
source.isChannelUrl = function(url) {
    return REGEX.CHANNEL_URL.test(url);
};

/**
 * Get channel information
 * @param {string} url - Channel URL
 * @returns {PlatformChannel} Channel information
 */
source.getChannel = function(url) {
    // Check if this is a category URL
    const categoryMatch = url.match(REGEX.CATEGORY_URL);
    if (categoryMatch) {
        const categorySlug = categoryMatch[1];
        return getCategoryChannel(categorySlug, url);
    }
    
    // Check if this is a series URL
    const seriesMatch = url.match(REGEX.SERIES_URL);
    if (seriesMatch) {
        const seriesId = seriesMatch[1];
        const collection = fetchCollectionDetails(seriesId);
        return createChannelFromCollection(collection);
    }
    
    throw new ScriptException('Invalid Channel URL');
};

/**
 * Get channel contents
 * @param {string} url - Channel URL
 * @returns {ContentPager} Paged results for channel content
 */
source.getChannelContents = function(url) {
    // Check if this is a category URL
    const categoryMatch = url.match(REGEX.CATEGORY_URL);
    if (categoryMatch) {
        const categorySlug = categoryMatch[1];
        
        // Get the category from state to ensure we have correct data
        const category = Object.values(state.categories)
            .find(cat => cat.name === categorySlug);
        
        const result = fetchContentDataWithCollections({
            url: `${URLS.API_V1}/media?filterBy=category&term=${categorySlug}&collections=true&limit=${API.VIDEOS_PER_PAGE}&sort=creation_date_desc`,
            processingInfo: { 
                categorySlug, 
                categoryName: formatCategoryName(categorySlug) 
            }
        });
        
        return new CategoryContentPager(
            categorySlug,
            result.items,
            result.hasMore,
            { page: 1, category }
        );
    }
    
    // Check if this is a series URL
    const seriesMatch = url.match(REGEX.SERIES_URL);
    if (seriesMatch) {
        const seriesId = seriesMatch[1];
        const collection = fetchCollectionDetails(seriesId);
        
        if (!collection) {
            throw new ScriptException('Collection not found');
        }
        
        // For collections, we already have all the videos in the collection object
        const videos = collection.media
            .sort((a, b) => a.collection_order - b.collection_order)
            .map(media => createVideoFromMedia(media, collection));
        
        // Return a content pager with all videos (no paging needed for collections)
        return new ContentPager(videos, false);
    }
    
    throw new ScriptException('Invalid Channel URL');
};

/**
 * Get search capabilities
 * @returns {Object} Search capabilities
 */
source.getSearchCapabilities = () => {
    return {
        types: [Type.Feed.Mixed],
        sorts: [Type.Order.Chronological],
        filters: []
    };
};

/**
 * Search for content
 * @param {string} query - Search query
 * @returns {ContentPager} Paged search results
 */
source.search = function(query, type, order, filters) {
    const result = fetchSearchData(query);
    
    return new SearchPager(
        result.items,
        result.hasMore,
        { query, page: 1, totalPages: result.body.nbPages }
    );
};

/**
 * Search for channels
 * @param {string} query - Search query
 * @returns {ContentPager} Paged search results
 */
source.searchChannels = function(query) {
    const channels = [];
    const searchQuery = query.toLowerCase().trim();
    const addedChannelIds = new Set(); // Track channel IDs to avoid duplicates
    
    // Search in categories
    Object.values(state.categories)
        .forEach(category => {
            const fullName = category.label.toLowerCase();
            if (fullName.includes(searchQuery)) {
                const channelId = category.name;
                if (!addedChannelIds.has(channelId)) {
                    channels.push(createChannelFromCategory(category));
                    addedChannelIds.add(channelId);
                }
            }
        });
    
    // Search for series/collections that match the query
    try {
        const searchBody = {
            query: searchQuery,
            hitsPerPage: 20,
            page: 0,
            filters: {
                obj_type: ["collection"] // Only search for collections
            }
        };
        
        const headers = {
            "Content-Type": "application/json"
        };
        
        const res = http.POST(`https://api.curiositystream.com/search`, JSON.stringify(searchBody), headers);
        
        if (res.isOk) {
            const body = JSON.parse(res.body);
            const seriesHits = body.hits || [];
            
            // Process each series and add to channels
            seriesHits.forEach(hit => {
                // Always use collection_id as the series identifier
                const collectionId = hit.collection_id;
                
                // Skip entries without a collection_id
                if (!collectionId) {
                    return;
                }
                
                const seriesChannelId = `series_${collectionId}`;
                
                // Skip if we've already added this channel
                if (addedChannelIds.has(seriesChannelId)) {
                    return;
                }
                
                // Check if we have complete collection data in cache
                let collection = null;
                
                // Try to get from cache first using the correct ID
                if (collectionId && state.collections[collectionId]) {
                    collection = state.collections[collectionId];
                } 
                
                // If not in cache, create minimal collection object from search result
                if (!collection) {
                    collection = {
                        id: collectionId,
                        title: hit.title,
                        description: hit.description || hit.short_description || "",
                        image_large: hit.image_large,
                        image_medium: hit.image_medium,
                        media_count: hit.media_count || 0
                    };
                }
                
                channels.push(createChannelFromCollection(collection));
                addedChannelIds.add(seriesChannelId);
                
                // We're only using collection_id, so no need to track alternative IDs
            });
        }
    } catch (error) {
        log(`Error searching for series channels: ${error.message}`);
    }
    
    return new ContentPager(channels, false);
};

/**
 * Check if a URL is a playlist
 * @param {string} url - URL to check
 * @returns {boolean} True if URL points to a playlist
 */
source.isPlaylistUrl = function(url) {
    return REGEX.SERIES_URL.test(url);
};

/**
 * Get playlist details
 * @param {string} url - Playlist URL
 * @returns {PlatformPlaylistDetails} Playlist details
 */
source.getPlaylist = function(url) {
    const match = url.match(REGEX.SERIES_URL);
    if (!match) {
        throw new ScriptException('Invalid Collection URL');
    }
    
    const seriesId = match[1];
    const collection = fetchCollectionDetails(seriesId);
    
    return createPlaylistDetails(collection);
};

/**
 * Get comments for content
 * @returns {CommentPager} Empty comment pager (comments not supported)
 */
source.getComments = function(url) {
    return new CommentPager([], false);
};

// ====================== CORE FUNCTIONALITY ======================

/**
 * Loads initial state data, including categories and subscription status
 */
function loadInitialState() {
    // Initialize collections cache
    state.collections = {};
    
    // Check subscription status if logged in
    if (bridge.isLoggedIn()) {
        const res = http.GET(`${URLS.API_V1}/user`, DEFAULT_HEADERS, true);
        if (res.isOk) {
            const body = JSON.parse(res.body);
            state.has_subscription = body.data.is_active && !body.data.is_free;
        }
        bridge.toast(`state.has_subscription: ${state.has_subscription}`);
    }
    
    // Load categories
    const url = `${URLS.API_V1}/categories`;
    const res = http.GET(url, DEFAULT_HEADERS);
    if (res.isOk) {
        const data = JSON.parse(res.body)?.data ?? [];
        processCategories(data);
    }
}

/**
 * Process categories data and store in state
 * @param {Array} categories - Category data from API
 */
function processCategories(categories) {
    categories.forEach(category => {
        const { background_url, description, image_url, label, name } = category;
        state.categories[name] = {
            background_url: background_url !== URLS.MISSING_IMG ? background_url : '',
            description,
            image_url: image_url !== URLS.MISSING_IMG ? image_url : '',
            label,
            name
        };
        
        // Process subcategories
        if (category.subcategories) {
            category.subcategories.forEach(subCategory => {
                const { background_url, description, image_url, label, name } = subCategory;
                state.categories[name] = {
                    background_url: background_url !== URLS.MISSING_IMG ? background_url : '',
                    description,
                    image_url: image_url !== URLS.MISSING_IMG ? image_url : '',
                    label,
                    name
                };
            });
        }
    });
}

/**
 * Fetches media details from the API
 * @param {string} contentId - Content ID
 * @param {boolean} isLoggedIn - Whether user is logged in
 * @returns {Object} Media details
 */
function fetchMediaDetails(contentId, isLoggedIn) {
    const batch = http.batch();
    batch.GET(`${URLS.API_V1}/media/${contentId}?encodingsNew=true&encodingsFormat=mpd`, DEFAULT_HEADERS, isLoggedIn);
    const [streamingDetailsResponse] = batch.execute();
    
    if (!streamingDetailsResponse.isOk) {
        throw new ScriptException('Failed to fetch content details');
    }
    
    const mainDetails = JSON.parse(streamingDetailsResponse.body);
    
    return {
        media: mainDetails.data,
        response: streamingDetailsResponse
    };
}

/**
 * Creates a video details object from media data
 * @param {Object} media - Media data from API
 * @param {Object} collection - Collection data if media is part of a collection
 * @returns {PlatformVideoDetails} Video details
 */
function createVideoDetails(media, collection) {
    // Prepare video sources
    const sources = createVideoSources(media);
    
    // Check if content is preview and user doesn't have subscription
    const is_preview = isMediaPreview(media) && !state.has_subscription;
    let duration = media.duration || 0;
    
    // Format title and description
    let name = formatMediaTitle(media);
    let description = formatMediaDescription(media, is_preview, collection);
    
    // Handle preview content
    if (is_preview) {
        name += ' (preview)';
        duration = 300; // Preview videos are limited to 5 minutes (300 seconds)
    }
    
    // Determine the appropriate author
    let author;
    if (collection) {
        // Use collection as the author for videos part of a series
        author = createAuthorLinkFromCollection(collection);
    } else {
        // Use category as the author for standalone videos
        const category = getCategoryByLabel(media.primary_category);
        author = category ? createChannelLinkFromCategory(category) : createDefaultChannelLink();
    }
    
    const videoDetails = new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, media.id.toString(), config.id),
        name: name,
        author,
        thumbnails: createThumbnails(media),
        description,
        duration: duration,
        url: constructMediaUrl(media),
        shareUrl: constructMediaUrl(media),
        isLive: false,
        video: sources.length > 0 ? new VideoSourceDescriptor(sources) : null,
        rating: createMediaRating(media),
        viewCount: media.num_views || media.view_count || -1,
        datetime: 0 // Without metadata request, we don't have this
    });
    
    // Add method to get recommendations
    videoDetails.getContentRecommendations = function() {
        return getRecommendations(media.id);
    };
    
    return videoDetails;
}

/**
 * Create video sources based on available encodings
 * @param {Object} media - Media data
 * @returns {Array} Array of video sources
 */
function createVideoSources(media) {
    const sources = [];
    
    // Handle preview videos by using the original duration or limiting to 5 minutes
    let duration = media.duration || 0;
    if (isMediaPreview(media) && !state.has_subscription) {
        duration = 300; // Preview videos limited to 5 minutes
    }
    
    // Check if there are any encodings available
    if (media.encodings && media.encodings.length > 0) {
        const encoding = media.encodings[0];
        // Add Dash source if available
        if (encoding.master_playlist_url) {
            sources.push(new DashSource({
                name: encoding.type || 'Dash',
                url: encoding.master_playlist_url,
                duration: duration,
                priority: true
            }));
        }
    }
    
    return sources;
}

/**
 * Get a category channel by slug
 * @param {string} categorySlug - Category slug
 * @param {string} url - Full channel URL
 * @returns {PlatformChannel} Channel object
 */
function getCategoryChannel(categorySlug, url) {
    let category = Object.values(state.categories)
        .find(category => category.name === categorySlug);
    
    if (!category) {
        category = {
            id: new PlatformID(PLATFORM, '', config.id),
            name: '',
            thumbnail: '',
            banner: '',
            subscribers: 0,
            description: '',
            url: url
        };
    }
    
    return createChannelFromCategory(category);
}

/**
 * Creates playlist details from collection data
 * @param {Object} collection - Collection data
 * @returns {PlatformPlaylistDetails} Playlist details
 */
function createPlaylistDetails(collection) {
    if (!collection) {
        throw new ScriptException('Collection not found');
    }
    
    // Get media (videos) in the collection
    const videos = collection.media
        .sort((a, b) => a.collection_order - b.collection_order)
        .map(media => createVideoFromMedia(media, collection));
    
    // Create PlatformPlaylistDetails
    return new PlatformPlaylistDetails({
        id: new PlatformID(PLATFORM, collection.id.toString(), config.id),
        name: collection.title,
        author: createAuthorLinkFromCollection(collection),
        description: collection.description || '',
        thumbnail: collection.image_large || collection.image_medium || '',
        url: constructCollectionUrl(collection),
        videoCount: collection.media_count || videos.length,
        contents: new VideoPager(videos, false)
    });
}

/**
 * Fetches collection details from the API
 * @param {string} seriesId - Series ID
 * @returns {Object} Collection data
 */
function fetchCollectionDetails(seriesId) {
    // Check if collection is already in state cache
    if (state.collections[seriesId]) {
        return state.collections[seriesId];
    }
    
    const res = http.GET(`${URLS.API_V2}/series/${seriesId}`, DEFAULT_HEADERS);
    
    if (!res.isOk) {
        throw new ScriptException('Failed to fetch collection');
    }
    
    const collection = JSON.parse(res.body).data;
    
    // Cache the collection
    if (collection) {
        state.collections[seriesId] = collection;
    }
    
    return collection;
}

/**
 * Fetches collection details in batch
 * @param {Array} collectionIds - Array of collection IDs
 * @returns {Object} Map of collection ID to collection data
 */
function fetchCollectionDetailsBatch(collectionIds) {
    if (!collectionIds || collectionIds.length === 0) {
        return {};
    }
    
    // Filter out collection IDs that are already cached
    const uncachedIds = collectionIds.filter(id => !state.collections[id]);
    
    // If all collections are cached, return the cache
    if (uncachedIds.length === 0) {
        return collectionIds.reduce((result, id) => {
            result[id] = state.collections[id];
            return result;
        }, {});
    }
    
    // Create batch request for uncached collections
    const batch = http.batch();
    uncachedIds.forEach(id => {
        batch.GET(`${URLS.API_V2}/series/${id}`, DEFAULT_HEADERS);
    });
    
    const responses = batch.execute();
    
    // Process the responses
    const collections = {};
    for (let i = 0; i < uncachedIds.length; i++) {
        const id = uncachedIds[i];
        const response = responses[i];
        
        if (response && response.isOk) {
            try {
                const collection = JSON.parse(response.body).data;
                if (collection) {
                    collections[id] = collection;
                    // Cache the collection
                    state.collections[id] = collection;
                }
            } catch (e) {
                log(`Error parsing collection ${id}: ${e.message}`);
            }
        }
    }
    
    // Add cached collections
    collectionIds.forEach(id => {
        if (state.collections[id] && !collections[id]) {
            collections[id] = state.collections[id];
        }
    });
    
    return collections;
}

/**
 * Get content recommendations for a video
 * @param {string} videoId - Video ID
 * @returns {ContentPager} Paged results with recommendations
 */
function getRecommendations(videoId) {
    const result = fetchContentDataWithCollections({
        url: `${URLS.API_V1}/media?filterBy=recommended&term=${videoId}&limit=${API.VIDEOS_PER_PAGE}&collections=true`
    });
    
    return new RecommendationsPager(
        result.items,
        result.hasMore,
        { videoId: videoId, page: 1 }
    );
}

// ====================== DATA MAPPING FUNCTIONS ======================

/**
 * Creates a channel from category data
 * @param {Object} category - Category data
 * @returns {PlatformChannel} Channel object
 */
function createChannelFromCategory(category) {
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, category.name, config.id),
        name: category.label,
        thumbnail: category.image_url || '',
        banner: category.background_url || '',
        subscribers: 0,
        description: `Documentaries in the ${category.label} category`,
        url: `${URLS.BASE}/categories/${category.name}`
    });
}

/**
 * Creates a channel from collection data
 * @param {Object} collection - Collection data
 * @returns {PlatformChannel} Channel object
 */
function createChannelFromCollection(collection) {
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, `series_${collection.id}`, config.id),
        name: collection.title,
        thumbnail: collection.image_large || collection.image_medium || '',
        banner: collection.background_url || '',
        subscribers: 0,
        description: collection.description || `Documentary series "${collection.title}"`,
        url: constructCollectionUrl(collection)
    });
}

/**
 * Creates an author link from category data
 * @param {Object} category - Category data
 * @returns {PlatformAuthorLink} Author link
 */
function createChannelLinkFromCategory(category) {
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, category?.name ?? '', config.id),
        category?.label ?? '',
        category?.name ? `${URLS.BASE}/categories/${category.name}` : '',
        category?.image_url ?? ''
    );
}

/**
 * Creates an author link from collection data
 * @param {Object} collection - Collection data
 * @returns {PlatformAuthorLink} Author link
 */
function createAuthorLinkFromCollection(collection) {
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, `series_${collection.id}`, config.id),
        collection.title,
        constructCollectionUrl(collection),
        collection.image_large || collection.image_medium || ''
    );
}

/**
 * Creates a video object from media data
 * @param {Object} media - Media data
 * @param {Object} collection - Collection data if media is part of a collection
 * @returns {PlatformVideo} Video object
 */
function createVideoFromMedia(media, collection) {
    // Check if media is part of a collection
    const hasCollection = !!collection;
    
    // Use collection/series as author if available, otherwise use category
    let author;
    if (hasCollection) {
        author = createAuthorLinkFromCollection(collection);
    } else {
        const creatorId = media.primary_category || 'CuriosityStream';
        const category = getCategoryByLabel(creatorId);
        author = createChannelLinkFromCategory(category);
    }
    
    // Check for preview content
    const is_preview = isMediaPreview(media) && !state.has_subscription;
    
    // Format title and duration
    let name = formatMediaTitle(media);
    let duration = media.duration || 0;
    
    if (is_preview) {
        name += ' (preview)';
        duration = 300; // Preview videos are limited to 5 minutes (300 seconds)
    }
    
    return new PlatformVideo({
        id: new PlatformID(PLATFORM, media.id.toString(), config.id),
        name,
        thumbnails: createThumbnails(media),
        description: media.description || media.short_description,
        duration,
        viewCount: media.view_count || -1,
        datetime: 0, // Without metadata request, we don't have this
        url: constructMediaUrl(media),
        isLive: false,
        author: author
    });
}

/**
 * Creates a playlist from collection data
 * @param {Object} collection - Collection data
 * @returns {PlatformPlaylist} Playlist object
 */
function createPlaylistFromCollection(collection) {
    return new PlatformPlaylist({
        id: new PlatformID(PLATFORM, collection.id.toString(), config.id),
        name: collection.title,
        url: constructCollectionUrl(collection),
        thumbnail: collection.image_large || collection.image_medium || '',
        author: createAuthorLinkFromCollection(collection),
        videoCount: collection.media_count || 0
    });
}

// ====================== UTILITY FUNCTIONS ======================

/**
 * Gets a category by label
 * @param {string} label - Category label
 * @returns {Object} Category data
 */
function getCategoryByLabel(label) {
    return Object.values(state.categories)
        .find(category => category && category.label === label);
}

/**
 * Creates thumbnails for media
 * @param {Object} media - Media data
 * @returns {Thumbnails} Thumbnails object
 */
function createThumbnails(media) {
    return new Thumbnails([
        new Thumbnail(media.image_medium, 0),
        new Thumbnail(media.image_large, 1)
    ]);
}

/**
 * Creates a rating object for media
 * @param {Object} media - Media data
 * @returns {RatingLikesDislikes} Rating object
 */
function createMediaRating(media) {
    return new RatingLikesDislikes(
        Math.round((media.rating || 0) * (media.num_ratings || 0)), // Likes (approximation)
        Math.round((media.num_ratings || 0) * (1 - (media.rating_percentage || 0) / 100)) // Dislikes (approximation)
    );
}

/**
 * Formats media title
 * @param {Object} media - Media data
 * @returns {string} Formatted title
 */
function formatMediaTitle(media) {
    return media.episode_number_display 
        ? `${media.episode_number_display} - ${media.title}` 
        : media.title;
}

/**
 * Formats media description
 * @param {Object} media - Media data
 * @param {boolean} is_preview - Whether the media is preview only
 * @param {Object} collection - Collection data if available
 * @returns {string} Formatted description
 */
function formatMediaDescription(media, is_preview, collection) {
    let description = media.description || media.short_description || '';
    
    if (media.collection_id) {
        const collectionInfo = collection || state.collections[media.collection_id];
        const collectionTitle = collectionInfo ? collectionInfo.title : "series";
        description += `<p><a href="${URLS.BASE}/series/${media.collection_id}">View complete "${collectionTitle}" series</a></p>`;
    }
    
    if (is_preview) {
        description += `<p>This is a preview video. Login with a valid subscription to watch the full content.</p>`;
    }
    
    return description;
}

/**
 * Checks if media is preview-only
 * @param {Object} media - Media data
 * @returns {boolean} True if media is preview-only
 */
function isMediaPreview(media) {
    return media?.status === 'preview';
}

/**
 * Formats a category name from slug
 * @param {string} categorySlug - Category slug
 * @returns {string} Formatted category name
 */
function formatCategoryName(categorySlug) {
    return categorySlug.split('-').map(word =>
        word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ').replace(/-/g, ' ');
}

/**
 * Constructs a media URL
 * @param {Object} media - Media data
 * @returns {string} Media URL
 */
function constructMediaUrl(media) {
    // Use obj_type to construct the most appropriate URL
    const objType = media.obj_type || 'media';
    return `${URLS.BASE}/${objType}/${media.title_id || media.id}`;
}

/**
 * Constructs a collection URL
 * @param {Object} collection - Collection data
 * @returns {string} Collection URL
 */
function constructCollectionUrl(collection) {
    return `${URLS.BASE}/series/${collection.id}`;
}

/**
 * Constructs a category URL
 * @param {string} category - Category name or object
 * @returns {string} Category URL
 */
function constructCategoryUrl(category) {
    // Convert to slug, replacing spaces and special characters
    const categorySlug = typeof category === 'string'
        ? category.toLowerCase().replace(/[&\\s]+/g, '-').replace(/[^a-z0-9-]/g, '')
        : '';
    return `${URLS.BASE}/categories/${encodeURIComponent(categorySlug)}`;
}

/**
 * Creates a default channel link
 * @returns {PlatformAuthorLink} Default author link
 */
function createDefaultChannelLink() {
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, "", config.id),
        "Curiosity Stream",
        "",
        ""
    );
}

/**
 * Creates a category author link
 * @param {string} categorySlug - Category slug
 * @param {string} categoryName - Category name
 * @returns {PlatformAuthorLink} Author link
 */
function createCategoryAuthorLink(categorySlug, categoryName) {
    // Find the category object in state to get its image
    const category = Object.values(state.categories)
        .find(cat => cat.name === categorySlug);
    
    // Get the image URL from the category, or use empty string if not found
    const imageUrl = category?.image_url || '';
    
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, categorySlug, config.id),
        categoryName,
        constructCategoryUrl(categoryName),
        imageUrl
    );
}

/**
 * Extract unique collection IDs from a list of videos
 * @param {Array} videos - Array of video items
 * @returns {Array} Array of unique collection IDs
 */
function extractCollectionIds(videos) {
    if (!videos || !Array.isArray(videos)) {
        return [];
    }
    
    // Filter out videos with collection_id and get unique IDs
    return [...new Set(
        videos
            .filter(video => video && video.collection_id)
            .map(video => video.collection_id)
    )];
}

/**
 * Maps content items to the appropriate platform object type
 * @param {Object} item - Content item
 * @param {Object} collectionsMap - Map of collection ID to collection data
 * @param {Object} processingInfo - Additional processing information
 * @returns {PlatformVideo|PlatformPlaylist} Mapped content
 */
function mapContent(item, collectionsMap = {}, processingInfo = {}) {
    if (item.obj_type === 'collection') {
        return createPlaylistFromCollection(item);
    } else {
        // For media items, check if it's part of a collection
        const collection = item.collection_id ? collectionsMap[item.collection_id] : null;
        
        // If part of a category page and not overridden by collection, use category as author
        if (!collection && processingInfo.categorySlug) {
            const video = createVideoFromMedia(item);
            video.author = createCategoryAuthorLink(processingInfo.categorySlug, processingInfo.categoryName);
            return video;
        }
        
        return createVideoFromMedia(item, collection);
    }
}

// ====================== DATA FETCHING ======================

/**
 * Fetches and processes content data with collection information
 * @param {Object} params - Request parameters
 * @returns {Object} Processed data
 */
function fetchContentDataWithCollections(params) {
    const { 
        url, 
        page = 1,
        processingInfo = {}
    } = params;
    
    const fullUrl = `${url}&page=${page}`;
    const res = http.GET(fullUrl, DEFAULT_HEADERS);
    
    if (!res.isOk) {
        return {
            items: [],
            hasMore: false,
            nextPage: page
        };
    }
    
    try {
        const body = JSON.parse(res.body);
        
        if (!body.data || !Array.isArray(body.data)) {
            return {
                items: [],
                hasMore: false,
                nextPage: page
            };
        }
        
        // Extract collection IDs and fetch collection details
        const collectionIds = extractCollectionIds(body.data);
        const collectionMap = fetchCollectionDetailsBatch(collectionIds);
        
        // Map items with collection data
        let items = body.data.map(item => mapContent(item, collectionMap, processingInfo));
        
        return {
            items,
            hasMore: body.paginator && body.paginator.current_page < body.paginator.total_pages,
            nextPage: page + 1,
            body
        };
    } catch (error) {
        log(`Error fetching content data: ${error.message}`);
        return {
            items: [],
            hasMore: false,
            nextPage: page
        };
    }
}

/**
 * Fetches and processes search data
 * @param {string} query - Search query
 * @param {number} page - Page number
 * @returns {Object} Processed search data
 */
function fetchSearchData(query, page = 1) {
    const searchBody = {
        query: query,
        hitsPerPage: 50,
        page: page - 1, // API is 0-indexed but our pagers use 1-indexed
        filters: {
            duration: ""
        }
    };
    
    const headers = {
        "Content-Type": "application/json"
    };
    
    try {
        const res = http.POST(`https://api.curiositystream.com/search`, JSON.stringify(searchBody), headers);
        
        if (!res.isOk) {
            return {
                items: [],
                hasMore: false,
                nextPage: page
            };
        }
        
        const body = JSON.parse(res.body);
        
        // Process search results from the hits array
        const hits = (body.hits || []).map(item => {
            // Create a standardized item that works with our mapContent function
            return {
                id: item.id || item.title_id,
                title: item.title,
                title_id: item.title_id || item.id,
                image_medium: item.image_medium,
                image_large: item.image_large,
                description: item.description || item.short_description,
                short_description: item.short_description,
                duration: item.duration,
                view_count: -1, // Not provided in search results
                year_produced: item.year_produced,
                primary_category: item.primary_category,
                obj_type: item.obj_type || "media",
                media_count: item.episodes_count,
                status: item.status, // Ensure status field is passed along for preview detection
                collection_id: item.collection_id // Include collection ID if present
            };
        });
        
        // Extract collection IDs and fetch collection details
        const collectionIds = extractCollectionIds(hits);
        const collectionMap = fetchCollectionDetailsBatch(collectionIds);
        
        // Map items with collection data
        const items = hits.map(item => mapContent(item, collectionMap));
        
        return {
            items,
            hasMore: body.page < body.nbPages - 1, // Account for 0-indexing
            nextPage: page + 1,
            body
        };
    } catch (error) {
        log(`Error in search: ${error.message}`);
        return {
            items: [],
            hasMore: false,
            nextPage: page
        };
    }
}

// ====================== PAGER CLASSES ======================

/**
 * Custom pager for home page content
 */
class CuriosityStreamHomePager extends VideoPager {
    constructor(initialResults, hasMore, context) {
        super(initialResults, hasMore, context);
    }
    
    nextPage() {
        const result = fetchContentDataWithCollections({
            url: `${URLS.API_V1}/media?collections=true&limit=${API.VIDEOS_PER_PAGE}`,
            page: this.context.page + 1
        });
        
        this.results = result.items;
        this.context.page = result.nextPage - 1;
        this.hasMore = result.hasMore;
        return this;
    }
}

/**
 * Custom pager for category content
 */
class CategoryContentPager extends VideoPager {
    constructor(categorySlug, initialResults, hasMore, context) {
        super(initialResults, hasMore, { ...context, categorySlug });
    }
    
    nextPage() {
        const categorySlug = this.context.categorySlug;
        
        const result = fetchContentDataWithCollections({
            url: `${URLS.API_V1}/media?filterBy=category&term=${categorySlug}&collections=true&limit=${API.VIDEOS_PER_PAGE}&sort=creation_date_desc`,
            page: this.context.page + 1,
            processingInfo: {
                categorySlug,
                categoryName: formatCategoryName(categorySlug)
            }
        });
        
        this.results = result.items;
        this.context.page = result.nextPage - 1;
        this.hasMore = result.hasMore;
        return this;
    }
}

/**
 * Custom pager for search results
 */
class SearchPager extends VideoPager {
    constructor(initialResults, hasMore, context) {
        super(initialResults, hasMore, context);
    }
    
    nextPage() {
        const result = fetchSearchData(this.context.query, this.context.page + 1);
        
        this.results = result.items;
        this.context.page = result.nextPage - 1;
        this.hasMore = result.hasMore;
        return this;
    }
}

/**
 * Custom pager for recommendations
 */
class RecommendationsPager extends VideoPager {
    constructor(initialResults, hasMore, context) {
        super(initialResults, hasMore, context);
    }
    
    nextPage() {
        const result = fetchContentDataWithCollections({
            url: `${URLS.API_V1}/media?filterBy=recommended&term=${this.context.videoId}&limit=${API.VIDEOS_PER_PAGE}&collections=true`,
            page: this.context.page + 1
        });
        
        this.results = result.items;
        this.context.page = result.nextPage - 1;
        this.hasMore = result.hasMore;
        return this;
    }
}

// Log that the plugin has loaded successfully
log('LOADED');