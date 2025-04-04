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
    CHANNEL_URL: /^https:\/\/(?:www\.)?curiositystream\.com\/categories\/([a-zA-Z0-9_-]+)\/?/,
    COLLECTION_URL: /^https:\/\/(?:www\.)?curiositystream\.com\/series\/(\d+)\/?/
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
    categories: {}
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
    const result = fetchContentData({
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
    
    return createVideoDetails(detailsResponse.media);
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
    const match = url.match(REGEX.CHANNEL_URL);
    if (!match) {
        throw new ScriptException('Invalid Category URL');
    }
    
    const categorySlug = match[1];
    return getCategoryChannel(categorySlug, url);
};

/**
 * Get channel contents
 * @param {string} url - Channel URL
 * @returns {ContentPager} Paged results for channel content
 */
source.getChannelContents = function(url) {
    const match = url.match(REGEX.CHANNEL_URL);
    if (!match) {
        throw new ScriptException('Invalid Category URL');
    }
    
    const categorySlug = match[1];
    
    const processCategoryItem = (item) => {
        const categoryName = formatCategoryName(categorySlug);
        
        if (item.obj_type === 'collection') {
            const playlist = createPlaylistFromCollection(item);
            // Override author to ensure it matches the current category
            playlist.author = createCategoryAuthorLink(categorySlug, categoryName);
            return playlist;
        } else {
            const video = createVideoFromMedia(item);
            // Override author to ensure it matches the current category
            video.author = createCategoryAuthorLink(categorySlug, categoryName);
            return video;
        }
    };
    
    const result = fetchContentData({
        url: `${URLS.API_V1}/media?filterBy=category&term=${categorySlug}&collections=true&limit=${API.VIDEOS_PER_PAGE}&sort=creation_date_desc`,
        processItemFn: processCategoryItem
    });
    
    return new CategoryContentPager(
        categorySlug,
        result.items,
        result.hasMore,
        { page: 1 }
    );
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
    
    Object.values(state.categories)
        .forEach(category => {
            const fullName = category.label.toLowerCase();
            if (fullName.includes(searchQuery)) {
                channels.push(createChannelFromCategory(category));
            }
        });
    
    return new ContentPager(channels, false);
};

/**
 * Check if a URL is a playlist
 * @param {string} url - URL to check
 * @returns {boolean} True if URL points to a playlist
 */
source.isPlaylistUrl = function(url) {
    return REGEX.COLLECTION_URL.test(url);
};

/**
 * Get playlist details
 * @param {string} url - Playlist URL
 * @returns {PlatformPlaylistDetails} Playlist details
 */
source.getPlaylist = function(url) {
    const match = url.match(REGEX.COLLECTION_URL);
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
 * @returns {PlatformVideoDetails} Video details
 */
function createVideoDetails(media) {
    // Prepare video sources
    const sources = createVideoSources(media);
    
    // Check if content is preview and user doesn't have subscription
    const is_preview = isMediaPreview(media) && !state.has_subscription;
    let duration = media.duration || 0;
    
    // Format title and description
    let name = formatMediaTitle(media);
    let description = formatMediaDescription(media, is_preview);
    
    // Handle preview content
    if (is_preview) {
        name += ' (free preview)';
        duration = 300; // Preview videos are limited to 5 minutes (300 seconds)
    }
    
    // Get author information from category
    const category = getCategoryByLabel(media.primary_category);
    const author = category ? createChannelLinkFromCategory(category) : createDefaultChannelLink();
    
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
    .map(media => createVideoFromMedia(media));
    // Create PlatformPlaylistDetails
    return new PlatformPlaylistDetails({
        id: new PlatformID(PLATFORM, collection.id.toString(), config.id),
        name: collection.title,
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, 'CuriosityStream', config.id),
            'CuriosityStream',
            URLS.BASE
        ),
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
    const res = http.GET(`${URLS.API_V2}/series/${seriesId}`, DEFAULT_HEADERS);
    
    if (!res.isOk) {
        throw new ScriptException('Failed to fetch collection');
    }
    
    return JSON.parse(res.body).data;
}

/**
 * Get content recommendations for a video
 * @param {string} videoId - Video ID
 * @returns {ContentPager} Paged results with recommendations
 */
function getRecommendations(videoId) {
    const result = fetchContentData({
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
 * Creates a video object from media data
 * @param {Object} media - Media data
 * @returns {PlatformVideo} Video object
 */
function createVideoFromMedia(media) {
    // Use primary category as the creator/channel
    const creatorId = media.primary_category || 'CuriosityStream';
    const is_preview = isMediaPreview(media) && !state.has_subscription;
    
    // Format title and duration
    let name = formatMediaTitle(media);
    let duration = media.duration || 0;
    
    if (is_preview) {
        name += ' (free preview)';
        duration = 300; // Preview videos are limited to 5 minutes (300 seconds)
    }
    
    // Get category and author information
    const category = getCategoryByLabel(creatorId);
    const author = createChannelLinkFromCategory(category);
    
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
        author: createDefaultChannelLink(),
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
 * @returns {string} Formatted description
 */
function formatMediaDescription(media, is_preview) {
    let description = media.description || media.short_description || '';
    
    if (media.collection_id) {
        description += `<p><a href="${URLS.BASE}/series/${media.collection_id}">Open complete playlist</a></p>`;
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
 * Maps content items to the appropriate platform object type
 * @param {Object} item - Content item
 * @returns {PlatformVideo|PlatformPlaylist} Mapped content
 */
function mapContent(item) {
    return item.obj_type === 'collection'
        ? createPlaylistFromCollection(item)
        : createVideoFromMedia(item);
}

// ====================== DATA FETCHING ======================

/**
 * Fetches and processes content data
 * @param {Object} params - Request parameters
 * @returns {Object} Processed data
 */
function fetchContentData(params) {
    const { 
        url, 
        page = 1,
        processItemFn = mapContent
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
        
        let items = body.data.map(item => processItemFn(item));
        
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
        const items = (body.hits || []).map(item => {
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
                status: item.status // Ensure status field is passed along for preview detection
            };
        }).map(e => mapContent(e));
        
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
        const result = fetchContentData({
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
        
        const processCategoryItem = (item) => {
            const categoryName = formatCategoryName(categorySlug);
            if (item.obj_type === 'collection') {
                const playlist = createPlaylistFromCollection(item);
                playlist.author = createCategoryAuthorLink(categorySlug, categoryName);
                return playlist;
            } else {
                const video = createVideoFromMedia(item);
                video.author = createCategoryAuthorLink(categorySlug, categoryName);
                return video;
            }
        };
        
        const result = fetchContentData({
            url: `${URLS.API_V1}/media?filterBy=category&term=${categorySlug}&collections=true&limit=${API.VIDEOS_PER_PAGE}&sort=creation_date_desc`,
            page: this.context.page + 1,
            processItemFn: processCategoryItem
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
        const result = fetchContentData({
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