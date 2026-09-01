// Bundled emoji dataset for the searchable reaction picker (no npm dependency —
// the bundle budget is <15MB, see tests/PERF.md). Plain string data parsed once
// at module load: each line is "emoji|name|space-separated keywords", grouped
// under category headers ("# Category"). Names double as searchable text. Kept
// to the common standard set (~600 emoji) rather than the full Unicode
// inventory — the compact CURATED_EMOJI quick set in lib/reactions.ts is
// unchanged and still seeds the "Frequently used" section.

export interface EmojiEntry {
  emoji: string;
  name: string;
  keywords: string[];
  category: string;
}

export const EMOJI_CATEGORIES = [
  'Smileys & People',
  'Animals & Nature',
  'Food & Drink',
  'Activities',
  'Travel & Places',
  'Objects',
  'Symbols',
] as const;

export type EmojiCategory = (typeof EMOJI_CATEGORIES)[number];

const RAW = `
# Smileys & People
😀|grinning face|smile happy joy
😃|grinning face with big eyes|smile happy joy
😄|grinning face with smiling eyes|smile happy laugh
😁|beaming face|grin smile teeth
😆|grinning squinting face|laugh haha lol
😅|grinning face with sweat|relief phew nervous laugh
🤣|rolling on the floor laughing|rofl lol haha funny
😂|face with tears of joy|lol laugh cry funny haha
🙂|slightly smiling face|smile ok fine
🙃|upside-down face|silly sarcasm
😉|winking face|wink flirt
😊|smiling face with smiling eyes|blush happy warm
😇|smiling face with halo|angel innocent
🥰|smiling face with hearts|love adore crush
😍|smiling face with heart-eyes|love crush adore
🤩|star-struck|wow starry eyes amazed
😘|face blowing a kiss|kiss love
😗|kissing face|kiss
😚|kissing face with closed eyes|kiss
😙|kissing face with smiling eyes|kiss
🥲|smiling face with tear|grateful touched proud
😋|face savoring food|yum delicious tasty
😛|face with tongue|tongue playful
😜|winking face with tongue|silly playful crazy
🤪|zany face|crazy wild silly goofy
😝|squinting face with tongue|tongue playful
🤑|money-mouth face|rich money dollar
🤗|smiling face with open hands|hug embrace
🤭|face with hand over mouth|oops giggle secret
🤫|shushing face|quiet shh secret
🤔|thinking face|hmm think consider wonder
🤐|zipper-mouth face|silence secret sealed
🤨|face with raised eyebrow|skeptic suspicious doubt
😐|neutral face|meh blank
😑|expressionless face|blank meh
😶|face without mouth|silence speechless
😏|smirking face|smirk smug sly
😒|unamused face|meh annoyed
🙄|face with rolling eyes|eyeroll whatever
😬|grimacing face|awkward eek yikes
🤥|lying face|pinocchio liar
😌|relieved face|calm content
😔|pensive face|sad thoughtful
😪|sleepy face|tired sleep
🤤|drooling face|drool hungry
😴|sleeping face|zzz sleep tired
😷|face with medical mask|sick mask ill
🤒|face with thermometer|sick fever ill
🤕|face with head-bandage|hurt injured
🤢|nauseated face|sick gross vomit
🤮|face vomiting|sick puke gross
🤧|sneezing face|sick sneeze achoo
🥵|hot face|heat sweating overheated
🥶|cold face|freezing frozen ice
🥴|woozy face|dizzy drunk tipsy
😵|face with crossed-out eyes|dizzy dead knocked out
🤯|exploding head|mind blown shocked wow
🤠|cowboy hat face|yeehaw cowboy
🥳|partying face|party celebrate birthday
🥸|disguised face|incognito glasses mustache
😎|smiling face with sunglasses|cool shades
🤓|nerd face|geek glasses smart
🧐|face with monocle|inspect fancy curious
😕|confused face|puzzled unsure
😟|worried face|concern anxious
🙁|slightly frowning face|sad frown
☹️|frowning face|sad frown
😮|face with open mouth|wow surprised gasp
😯|hushed face|surprised quiet
😲|astonished face|shocked amazed
😳|flushed face|blush embarrassed shocked
🥺|pleading face|puppy eyes beg cute
😦|frowning face with open mouth|shocked frown
😧|anguished face|shocked pained
😨|fearful face|scared afraid
😰|anxious face with sweat|nervous worried
😥|sad but relieved face|phew disappointed
😢|crying face|sad tear cry
😭|loudly crying face|sob cry bawling sad
😱|face screaming in fear|scream shocked horror
😖|confounded face|frustrated upset
😣|persevering face|struggling effort
😞|disappointed face|sad let down
😓|downcast face with sweat|tired hard stressed
😩|weary face|tired exhausted ugh
😫|tired face|exhausted upset
🥱|yawning face|bored tired sleepy
😤|face with steam from nose|frustrated determined triumph
😡|enraged face|angry mad rage furious
😠|angry face|mad annoyed
🤬|face with symbols on mouth|swearing cursing angry
😈|smiling face with horns|devil evil mischief
👿|angry face with horns|devil evil mad
💀|skull|dead death dying skeleton
☠️|skull and crossbones|danger dead poison
💩|pile of poo|poop crap funny
🤡|clown face|clown circus joke
👹|ogre|monster japanese
👺|goblin|monster japanese
👻|ghost|boo halloween spooky
👽|alien|ufo extraterrestrial space
🤖|robot|bot machine ai
😺|grinning cat|cat smile
😸|grinning cat with smiling eyes|cat happy
😹|cat with tears of joy|cat laugh lol
😻|smiling cat with heart-eyes|cat love
🙈|see-no-evil monkey|monkey hide oops
🙉|hear-no-evil monkey|monkey ears
🙊|speak-no-evil monkey|monkey secret oops
👋|waving hand|wave hello hi goodbye bye
🤚|raised back of hand|stop hand
✋|raised hand|stop high five
🖖|vulcan salute|spock star trek
👌|OK hand|okay perfect nice
🤌|pinched fingers|italian chef kiss
🤏|pinching hand|small tiny bit
✌️|victory hand|peace two
🤞|crossed fingers|luck hope
🤟|love-you gesture|love rock
🤘|sign of the horns|rock metal
🤙|call me hand|shaka hang loose
👈|backhand index pointing left|point left
👉|backhand index pointing right|point right
👆|backhand index pointing up|point up
👇|backhand index pointing down|point down
☝️|index pointing up|point one
👍|thumbs up|like yes approve good ok
👎|thumbs down|dislike no disapprove bad
✊|raised fist|power solidarity punch
👊|oncoming fist|fist bump punch
🤛|left-facing fist|fist bump
🤜|right-facing fist|fist bump
👏|clapping hands|applause bravo congrats
🙌|raising hands|hooray celebration praise yay
👐|open hands|hug open
🤲|palms up together|prayer cupped
🤝|handshake|deal agreement partnership
🙏|folded hands|please thanks pray hope namaste
✍️|writing hand|write pen note
💅|nail polish|manicure sassy
🤳|selfie|photo camera phone
💪|flexed biceps|strong muscle strength gym
🦾|mechanical arm|prosthetic robot strong
👀|eyes|look see watch eyes looking
👁️|eye|look see
🧠|brain|smart mind think
🦷|tooth|dentist teeth
👅|tongue|taste lick
👄|mouth|lips kiss
👶|baby|infant child
🧒|child|kid young
👦|boy|kid male
👧|girl|kid female
🧑|person|adult human
👨|man|male adult
👩|woman|female adult
🧓|older person|elderly senior
👮|police officer|cop law
🕵️|detective|spy sleuth investigate
💂|guard|british soldier
🥷|ninja|stealth fighter
👷|construction worker|builder hard hat
🤴|prince|royal crown
👸|princess|royal crown
🦸|superhero|hero super
🦹|supervillain|villain evil
🧙|mage|wizard magic
🧚|fairy|magic wings
🧛|vampire|dracula fangs
🧟|zombie|undead walking dead
💆|person getting massage|spa relax
🚶|person walking|walk stroll
🏃|person running|run sprint jog hurry
💃|woman dancing|dance salsa
🕺|man dancing|dance disco
👯|people with bunny ears|party twins dancing
🧘|person in lotus position|yoga meditate zen
👫|woman and man holding hands|couple pair
💏|kiss|couple love
💑|couple with heart|love relationship
👪|family|parents kids
🗣️|speaking head|talk speak announce
👤|bust in silhouette|user person profile
👥|busts in silhouette|users people group
# Animals & Nature
🐶|dog face|puppy pet
🐱|cat face|kitten pet
🐭|mouse face|rodent
🐹|hamster|pet rodent
🐰|rabbit face|bunny
🦊|fox|clever
🐻|bear|grizzly
🐼|panda|china bear
🐨|koala|australia
🐯|tiger face|cat stripes
🦁|lion|king cat
🐮|cow face|moo farm
🐷|pig face|oink farm
🐸|frog|toad ribbit
🐵|monkey face|ape
🐔|chicken|hen farm
🐧|penguin|bird cold
🐦|bird|tweet fly
🐤|baby chick|chick bird
🦆|duck|quack bird
🦅|eagle|bird america
🦉|owl|bird wise night
🦇|bat|vampire night
🐺|wolf|howl wild
🐗|boar|pig wild
🐴|horse face|pony
🦄|unicorn|magic rainbow
🐝|honeybee|bee buzz
🐛|bug|insect caterpillar
🦋|butterfly|insect pretty
🐌|snail|slow
🐞|lady beetle|ladybug insect
🐜|ant|insect
🦗|cricket|insect chirp
🕷️|spider|web insect
🦂|scorpion|sting
🐢|turtle|slow tortoise
🐍|snake|serpent hiss
🦎|lizard|gecko reptile
🦖|t-rex|dinosaur
🦕|sauropod|dinosaur
🐙|octopus|sea tentacles
🦑|squid|sea
🦐|shrimp|sea prawn
🦞|lobster|sea
🦀|crab|sea
🐡|blowfish|fish sea
🐠|tropical fish|sea aquarium
🐟|fish|sea
🐬|dolphin|sea flipper
🐳|spouting whale|sea
🐋|whale|sea
🦈|shark|sea jaws
🐊|crocodile|alligator
🐅|tiger|cat wild
🐆|leopard|cat wild
🦓|zebra|stripes
🦍|gorilla|ape
🐘|elephant|trunk
🦒|giraffe|tall neck
🐪|camel|desert
🦙|llama|alpaca
🐐|goat|farm
🐑|ewe|sheep farm
🐎|horse|racing gallop
🐖|pig|farm oink
🐀|rat|rodent
🐿️|chipmunk|squirrel
🦔|hedgehog|spiny
🐾|paw prints|tracks pet
🐉|dragon|mythical fire
🌵|cactus|desert plant
🎄|christmas tree|xmas holiday
🌲|evergreen tree|pine forest
🌳|deciduous tree|forest nature
🌴|palm tree|beach tropical
🌱|seedling|plant sprout grow
🌿|herb|plant leaf
☘️|shamrock|irish luck clover
🍀|four leaf clover|luck lucky irish
🍁|maple leaf|canada fall autumn
🍂|fallen leaf|autumn fall
🍃|leaf fluttering in wind|nature breeze
🌷|tulip|flower spring
🌹|rose|flower love
🌺|hibiscus|flower tropical
🌸|cherry blossom|flower spring sakura
🌼|blossom|flower daisy
🌻|sunflower|flower yellow
🌞|sun with face|sunny bright
🌝|full moon face|moon night
🌙|crescent moon|night moon
⭐|star|favorite gold
🌟|glowing star|sparkle shine
✨|sparkles|shiny magic clean new
⚡|high voltage|lightning zap electric fast
☄️|comet|space meteor
💥|collision|boom explosion bang
🔥|fire|flame hot lit burn
🌈|rainbow|pride color weather
☀️|sun|sunny bright weather
⛅|sun behind cloud|partly cloudy weather
☁️|cloud|cloudy weather
🌧️|cloud with rain|rain weather
⛈️|cloud with lightning and rain|storm thunder weather
❄️|snowflake|snow cold winter
⛄|snowman|snow winter
🌊|water wave|ocean sea surf
💧|droplet|water drop
🫧|bubbles|soap clean
# Food & Drink
🍏|green apple|fruit
🍎|red apple|fruit
🍐|pear|fruit
🍊|tangerine|orange fruit
🍋|lemon|sour fruit
🍌|banana|fruit
🍉|watermelon|fruit summer
🍇|grapes|fruit wine
🍓|strawberry|fruit berry
🫐|blueberries|fruit berry
🍈|melon|fruit
🍒|cherries|fruit
🍑|peach|fruit
🥭|mango|fruit tropical
🍍|pineapple|fruit tropical
🥥|coconut|fruit tropical
🥝|kiwi fruit|fruit
🍅|tomato|vegetable fruit
🥑|avocado|guacamole
🥦|broccoli|vegetable
🥬|leafy green|lettuce vegetable
🥒|cucumber|pickle vegetable
🌶️|hot pepper|spicy chili
🌽|ear of corn|maize vegetable
🥕|carrot|vegetable
🥔|potato|vegetable
🍠|roasted sweet potato|yam
🥐|croissant|bread french
🥯|bagel|bread
🍞|bread|loaf toast
🥖|baguette bread|french bread
🧀|cheese wedge|cheddar
🥚|egg|breakfast
🍳|cooking|fried egg breakfast
🧈|butter|dairy
🥞|pancakes|breakfast syrup
🧇|waffle|breakfast
🥓|bacon|breakfast pork
🥩|cut of meat|steak
🍗|poultry leg|chicken drumstick
🍖|meat on bone|bbq
🌭|hot dog|frankfurter
🍔|hamburger|burger fast food
🍟|french fries|fries fast food
🍕|pizza|slice cheese
🥪|sandwich|lunch
🌮|taco|mexican
🌯|burrito|mexican wrap
🥗|green salad|healthy
🍝|spaghetti|pasta noodles
🍜|steaming bowl|ramen noodles soup
🍲|pot of food|stew soup
🍛|curry rice|indian
🍣|sushi|japanese fish
🍱|bento box|japanese lunch
🥟|dumpling|gyoza potsticker
🍤|fried shrimp|tempura
🍙|rice ball|onigiri japanese
🍚|cooked rice|bowl
🥠|fortune cookie|chinese
🍧|shaved ice|dessert
🍨|ice cream|dessert
🍦|soft ice cream|dessert cone
🥧|pie|dessert
🧁|cupcake|dessert
🍰|shortcake|cake dessert
🎂|birthday cake|celebrate party
🍮|custard|pudding flan
🍭|lollipop|candy sweet
🍬|candy|sweet
🍫|chocolate bar|sweet
🍿|popcorn|movie snack
🍩|doughnut|donut sweet
🍪|cookie|sweet biscuit
🌰|chestnut|nut
🥜|peanuts|nut
🍯|honey pot|sweet bee
🥛|glass of milk|dairy drink
🍼|baby bottle|milk
☕|hot beverage|coffee tea drink
🍵|teacup without handle|tea green drink
🧃|beverage box|juice drink
🥤|cup with straw|soda drink
🍶|sake|japanese drink
🍺|beer mug|drink pint
🍻|clinking beer mugs|cheers drink toast
🥂|clinking glasses|cheers celebrate toast champagne
🍷|wine glass|drink red
🥃|tumbler glass|whiskey drink
🍸|cocktail glass|martini drink
🍹|tropical drink|cocktail vacation
🧉|mate|drink tea
🧊|ice|cube cold
🥄|spoon|utensil
🍴|fork and knife|utensils eat
🍽️|fork and knife with plate|dinner eat
# Activities
⚽|soccer ball|football sport
🏀|basketball|sport hoops
🏈|american football|sport nfl
⚾|baseball|sport
🥎|softball|sport
🎾|tennis|sport racket
🏐|volleyball|sport
🏉|rugby football|sport
🥏|flying disc|frisbee
🎱|pool 8 ball|billiards
🏓|ping pong|table tennis
🏸|badminton|sport
🏒|ice hockey|sport
🥍|lacrosse|sport
🏹|bow and arrow|archery
🎣|fishing pole|fish
🥊|boxing glove|fight sport
🥋|martial arts uniform|karate judo
⛸️|ice skate|skating winter
🎿|skis|skiing winter
🛷|sled|winter
⛷️|skier|winter sport
🏂|snowboarder|winter sport
🏋️|person lifting weights|gym workout
🤸|person cartwheeling|gymnastics
🤺|person fencing|sword sport
⛹️|person bouncing ball|basketball
🏌️|person golfing|golf
🏄|person surfing|surf beach
🏊|person swimming|swim pool
🤽|person playing water polo|sport
🚣|person rowing boat|row
🧗|person climbing|climb bouldering
🚴|person biking|bike cycling
🚵|person mountain biking|bike
🏇|horse racing|jockey
🏆|trophy|win winner champion award
🥇|1st place medal|gold winner first
🥈|2nd place medal|silver second
🥉|3rd place medal|bronze third
🏅|sports medal|award winner
🎖️|military medal|honor award
🎫|ticket|admission event
🎟️|admission tickets|event
🎪|circus tent|carnival
🤹|person juggling|juggle circus
🎭|performing arts|theater drama masks
🩰|ballet shoes|dance
🎨|artist palette|art paint design
🎬|clapper board|movie film action
🎤|microphone|sing karaoke
🎧|headphone|music listen audio
🎼|musical score|music sheet
🎵|musical note|music song
🎶|musical notes|music song melody
🎹|musical keyboard|piano music
🥁|drum|music beat
🎷|saxophone|music jazz
🎺|trumpet|music brass
🎸|guitar|music rock
🎻|violin|music strings
🎲|game die|dice random gamble
♟️|chess pawn|chess strategy
🎯|bullseye|target dart goal
🎳|bowling|strike pins
🎮|video game|gaming controller
🕹️|joystick|arcade gaming
🎰|slot machine|casino gamble
🧩|puzzle piece|jigsaw fit
🪁|kite|fly wind
🎗️|reminder ribbon|awareness
# Travel & Places
🚗|automobile|car drive vehicle
🚕|taxi|cab car
🚙|sport utility vehicle|suv car
🚌|bus|transport
🚎|trolleybus|transport
🏎️|racing car|fast f1
🚓|police car|cop
🚑|ambulance|emergency medical
🚒|fire engine|firetruck emergency
🚐|minibus|van
🛻|pickup truck|truck
🚚|delivery truck|shipping
🚛|articulated lorry|semi truck
🚜|tractor|farm
🛵|motor scooter|vespa
🏍️|motorcycle|bike motorbike
🚲|bicycle|bike cycle
🛴|kick scooter|scooter
🚏|bus stop|transport
🚉|station|train transport
🚂|locomotive|train steam
🚆|train|rail transport
🚇|metro|subway underground
🚊|tram|transport
🚄|high-speed train|bullet shinkansen
✈️|airplane|flight fly travel plane
🛫|airplane departure|takeoff flight
🛬|airplane arrival|landing flight
🪂|parachute|skydive
💺|seat|chair airplane
🚀|rocket|launch ship space fast startup
🛸|flying saucer|ufo alien
🚁|helicopter|chopper
⛵|sailboat|boat sea
🚤|speedboat|boat
🛳️|passenger ship|cruise boat
⛴️|ferry|boat
🚢|ship|boat sea
⚓|anchor|ship sea
🗼|tokyo tower|japan landmark
🗽|statue of liberty|new york usa
🗿|moai|easter island stone
🏰|castle|palace fairy tale
🏯|japanese castle|japan
🏟️|stadium|arena sports
🎡|ferris wheel|carnival fair
🎢|roller coaster|amusement park
🎠|carousel horse|merry-go-round
⛲|fountain|water park
⛱️|umbrella on ground|beach
🏖️|beach with umbrella|vacation sand
🏝️|desert island|tropical vacation
⛰️|mountain|peak nature
🏔️|snow-capped mountain|peak winter
🗻|mount fuji|japan mountain
🏕️|camping|tent outdoors
⛺|tent|camping
🏠|house|home building
🏡|house with garden|home
🏢|office building|work city
🏥|hospital|medical health
🏦|bank|money building
🏨|hotel|stay travel
🏪|convenience store|shop
🏫|school|education building
🏛️|classical building|museum government
⛪|church|religion building
🕌|mosque|religion building
🛕|hindu temple|religion building
🕍|synagogue|religion building
🌁|foggy|city fog
🌃|night with stars|city night
🏙️|cityscape|skyline urban
🌄|sunrise over mountains|morning
🌅|sunrise|morning sun
🌆|cityscape at dusk|evening
🌇|sunset|evening sun
🌉|bridge at night|city
🗺️|world map|travel geography
🧭|compass|navigate direction
🌍|globe showing europe-africa|earth world
🌎|globe showing americas|earth world
🌏|globe showing asia-australia|earth world
🪐|ringed planet|saturn space
# Objects
⌚|watch|time wrist
📱|mobile phone|iphone smartphone cell
💻|laptop|computer macbook work
⌨️|keyboard|type computer
🖥️|desktop computer|imac monitor
🖨️|printer|print paper
🖱️|computer mouse|click
💾|floppy disk|save disk
💿|optical disk|cd dvd
📀|dvd|disk
📼|videocassette|vhs tape
📷|camera|photo picture
📸|camera with flash|photo picture
📹|video camera|record film
🎥|movie camera|film record
📽️|film projector|movie cinema
📞|telephone receiver|call phone
☎️|telephone|call phone
📟|pager|beeper
📠|fax machine|fax
📺|television|tv screen
📻|radio|music broadcast
🎙️|studio microphone|podcast record
⏰|alarm clock|wake time morning
⏱️|stopwatch|timer time
⏳|hourglass not done|time waiting
⌛|hourglass done|time
🔋|battery|power charge
🔌|electric plug|power charge
💡|light bulb|idea bright
🔦|flashlight|torch light
🕯️|candle|light flame
🗑️|wastebasket|trash delete bin
💸|money with wings|spend cash lost
💵|dollar banknote|money cash usd
💴|yen banknote|money cash
💶|euro banknote|money cash
💷|pound banknote|money cash
💰|money bag|cash rich funding
🪙|coin|money gold
💳|credit card|payment money
🧾|receipt|invoice bill
💎|gem stone|diamond jewel
⚖️|balance scale|justice law weigh
🧰|toolbox|tools repair
🔧|wrench|tool fix
🔨|hammer|tool build
⚒️|hammer and pick|tools work
🛠️|hammer and wrench|tools build fix
⛏️|pick|mine tool
🪛|screwdriver|tool fix
🔩|nut and bolt|hardware
⚙️|gear|settings cog config
🧲|magnet|attract
💣|bomb|explosive boom
🧨|firecracker|dynamite
🪓|axe|chop wood
🔪|kitchen knife|cut chef
🗡️|dagger|knife weapon
⚔️|crossed swords|battle fight
🛡️|shield|protect defense security
🏺|amphora|vase pottery
🔮|crystal ball|fortune magic future
📿|prayer beads|religion
🧿|nazar amulet|evil eye
💈|barber pole|haircut
⚗️|alembic|chemistry
🔭|telescope|astronomy stars
🔬|microscope|science lab
💊|pill|medicine drug health
💉|syringe|shot vaccine medical
🩹|adhesive bandage|bandaid heal
🩺|stethoscope|doctor medical
🌡️|thermometer|temperature fever
🚪|door|exit entrance
🛏️|bed|sleep rest
🛋️|couch and lamp|sofa relax
🪑|chair|seat sit
🚽|toilet|bathroom wc
🚿|shower|bath clean
🛁|bathtub|bath relax
🧴|lotion bottle|soap cream
🧷|safety pin|pin
🧹|broom|sweep clean
🧺|basket|laundry
🧻|roll of paper|toilet paper
🧼|soap|clean wash
🧽|sponge|clean
🧯|fire extinguisher|safety
🛒|shopping cart|buy store
🛍️|shopping bags|buy retail
🎁|wrapped gift|present birthday
🎈|balloon|party celebrate
🎉|party popper|celebrate congrats tada hooray
🎊|confetti ball|celebrate party
🎀|ribbon|bow gift
🪄|magic wand|wizard magic
📦|package|box shipping delivery
📫|closed mailbox with raised flag|mail inbox
📮|postbox|mail letter
✉️|envelope|email letter mail message
📧|e-mail|email message
📨|incoming envelope|email received
📩|envelope with arrow|email send
📤|outbox tray|send upload
📥|inbox tray|receive download
📜|scroll|document ancient
📃|page with curl|document
📄|page facing up|document file
📑|bookmark tabs|pages
📊|bar chart|graph stats data analytics
📈|chart increasing|growth up trending
📉|chart decreasing|decline down loss
🗒️|spiral notepad|notes
📅|calendar|date schedule
📆|tear-off calendar|date schedule
🗓️|spiral calendar|date schedule
📇|card index|rolodex contacts
🗃️|card file box|archive
🗄️|file cabinet|archive storage
📋|clipboard|list copy
📁|file folder|directory documents
📂|open file folder|directory documents
🗞️|rolled-up newspaper|news press
📰|newspaper|news press
📓|notebook|journal notes
📔|notebook with decorative cover|journal
📕|closed book|read
📗|green book|read
📘|blue book|read
📙|orange book|read
📚|books|library read study
📖|open book|read study
🔖|bookmark|save marker
🧮|abacus|math count
📌|pushpin|pin location note
📍|round pushpin|pin location map
✂️|scissors|cut
🖊️|pen|write ballpoint
🖋️|fountain pen|write fancy
✒️|black nib|write pen
🖌️|paintbrush|art paint
🖍️|crayon|draw color
📝|memo|note write pencil document
✏️|pencil|write draw edit
🔍|magnifying glass tilted left|search find zoom
🔎|magnifying glass tilted right|search find zoom
🔏|locked with pen|privacy secure
🔐|locked with key|secure
🔒|locked|lock secure private
🔓|unlocked|open unlock
🔑|key|password unlock access
🗝️|old key|unlock vintage
🔗|link|chain url connect
⛓️|chains|link
# Symbols
❤️|red heart|love like heart
🧡|orange heart|love
💛|yellow heart|love friendship
💚|green heart|love nature
💙|blue heart|love trust
💜|purple heart|love
🖤|black heart|love dark
🤍|white heart|love pure
🤎|brown heart|love
💔|broken heart|heartbreak sad breakup
❣️|heart exclamation|love
💕|two hearts|love affection
💞|revolving hearts|love
💓|beating heart|love pulse
💗|growing heart|love
💖|sparkling heart|love sparkle
💘|heart with arrow|cupid love
💝|heart with ribbon|gift love
☮️|peace symbol|peace
☯️|yin yang|balance tao
🔴|red circle|stop record
🟠|orange circle|circle
🟡|yellow circle|circle
🟢|green circle|go online active
🔵|blue circle|circle
🟣|purple circle|circle
⚫|black circle|circle
⚪|white circle|circle
🟤|brown circle|circle
🔺|red triangle pointed up|up
🔻|red triangle pointed down|down
🔸|small orange diamond|shape
🔹|small blue diamond|shape
💠|diamond with a dot|shape
🔘|radio button|select
🏁|chequered flag|finish race done
🚩|triangular flag|warning report flag
🏳️|white flag|surrender flag
🏳️‍🌈|rainbow flag|pride lgbtq
🏴‍☠️|pirate flag|jolly roger
✅|check mark button|done yes complete approved
☑️|check box with check|done complete todo
✔️|check mark|done yes
❌|cross mark|no wrong delete x
❎|cross mark button|no wrong
➕|plus|add math
➖|minus|subtract math
➗|divide|math
✖️|multiply|math x
♾️|infinity|forever
‼️|double exclamation mark|important urgent
⁉️|exclamation question mark|what surprise
❓|red question mark|question help what
❔|white question mark|question
❕|white exclamation mark|attention
❗|red exclamation mark|important attention alert
💱|currency exchange|money convert
💲|heavy dollar sign|money price
⚕️|medical symbol|health medicine
♻️|recycling symbol|recycle green
🔱|trident emblem|poseidon
📛|name badge|label
🔰|japanese symbol for beginner|new learner
⭕|hollow red circle|correct circle
🌀|cyclone|hurricane spiral
💤|ZZZ|sleep tired
🚫|prohibited|no forbidden ban
🚭|no smoking|forbidden
🔞|no one under eighteen|adult
🔅|dim button|brightness low
🔆|bright button|brightness high
⚠️|warning|caution alert danger
™️|trade mark|tm
🆗|OK button|okay approved
🆕|NEW button|new fresh
🆙|UP! button|up level
🆒|COOL button|cool
🆓|FREE button|free
🆚|VS button|versus battle
ℹ️|information|info help
🅿️|P button|parking
🔤|input latin letters|abc alphabet
🔢|input numbers|1234 numbers
#️⃣|keycap number sign|hashtag pound
*️⃣|keycap asterisk|star
0️⃣|keycap 0|zero number
1️⃣|keycap 1|one number
2️⃣|keycap 2|two number
3️⃣|keycap 3|three number
4️⃣|keycap 4|four number
5️⃣|keycap 5|five number
6️⃣|keycap 6|six number
7️⃣|keycap 7|seven number
8️⃣|keycap 8|eight number
9️⃣|keycap 9|nine number
🔟|keycap 10|ten number
▶️|play button|start media
⏸️|pause button|media
⏯️|play or pause button|media
⏹️|stop button|media
⏺️|record button|media
⏭️|next track button|skip media
⏮️|last track button|previous media
⏩|fast-forward button|media
⏪|fast reverse button|rewind media
🔀|shuffle tracks button|random media
🔁|repeat button|loop media
🔂|repeat single button|loop media
◀️|reverse button|back media
🔼|upwards button|up
🔽|downwards button|down
⬆️|up arrow|north direction
⬇️|down arrow|south direction
➡️|right arrow|east direction next
⬅️|left arrow|west direction back
↗️|up-right arrow|northeast
↘️|down-right arrow|southeast
↙️|down-left arrow|southwest
↖️|up-left arrow|northwest
↕️|up-down arrow|vertical
↔️|left-right arrow|horizontal
↩️|right arrow curving left|return reply
↪️|left arrow curving right|forward
⤴️|right arrow curving up|up
⤵️|right arrow curving down|down
🔃|clockwise vertical arrows|refresh reload
🔄|counterclockwise arrows button|refresh sync reload
🛜|wireless|wifi internet
🔔|bell|notification alert ring
🔕|bell with slash|mute silence
🔊|speaker high volume|loud sound
🔉|speaker medium volume|sound
🔈|speaker low volume|sound quiet
🔇|muted speaker|mute silence
📣|megaphone|announce shout
📢|loudspeaker|announce broadcast
💬|speech balloon|comment chat message talk
💭|thought balloon|thinking idea
🗯️|right anger bubble|angry comic
♠️|spade suit|cards
♣️|club suit|cards
♥️|heart suit|cards
♦️|diamond suit|cards
🃏|joker|cards wild
💯|hundred points|100 perfect score full
`;

function parse(raw: string): EmojiEntry[] {
  const entries: EmojiEntry[] = [];
  const seen = new Set<string>();
  let category = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') && trimmed.includes(' ')) {
      // Category header ("# Smileys & People") — but not the "#️⃣" keycap line.
      const maybe = trimmed.replace(/^#\s*/, '');
      if (!trimmed.includes('|')) {
        category = maybe;
        continue;
      }
    }
    const parts = trimmed.split('|');
    if (parts.length < 2 || !category) continue;
    const [emoji, name, kw = ''] = parts;
    const e = emoji.trim();
    if (seen.has(e)) continue;
    seen.add(e);
    entries.push({
      emoji: e,
      name: name.trim(),
      keywords: kw.trim().length > 0 ? kw.trim().split(/\s+/) : [],
      category,
    });
  }
  return entries;
}

/** The full bundled emoji dataset, in category display order. */
export const EMOJI_DATA: readonly EmojiEntry[] = parse(RAW);
