import { useState, useEffect, useRef } from "react";
import { syncConfigured, supabase, fetchKitchen, pushKitchen } from "./cloudSync.js";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";

/* ---------- storage keys ---------- */

const K_RECIPES = "becs-kitchen-recipes-v1";
const K_PLAN = "becs-kitchen-plan-v1";
const K_SHOP = "becs-kitchen-shopping-v1";
const K_FAVS = "becs-kitchen-favs-v1";
const K_SETTINGS = "becs-kitchen-settings-v1";
const K_TEMPLATES = "becs-kitchen-templates-v1";
const K_MYTIPS = "becs-kitchen-mytips-v1";
const K_MYPANS = "becs-kitchen-mypans-v1";
const K_BAKEPLANS = "becs-kitchen-bakeplans-v1";

const DEFAULT_SETTINGS = { defaultServes: null, oven: "fan", theme: "olive", mode: "auto", prepTicks: true };

const uid = () => Math.random().toString(36).slice(2, 10);

/* storage backend — durable: Capacitor Filesystem on native, localStorage on web */
const IS_NATIVE = Capacitor.isNativePlatform();
const fileFor = (key) => key.replace(/[^a-z0-9-]/gi, "_") + ".json";
const storageGet = async (key) => {
  if (IS_NATIVE) {
    try {
      const res = await Filesystem.readFile({ path: fileFor(key), directory: Directory.Data, encoding: Encoding.UTF8 });
      return { key, value: res.data };
    } catch {
      const legacy = localStorage.getItem(key);
      if (legacy != null) {
        await Filesystem.writeFile({ path: fileFor(key), directory: Directory.Data, encoding: Encoding.UTF8, data: legacy, recursive: true });
        return { key, value: legacy };
      }
      throw new Error("not found");
    }
  }
  const v = localStorage.getItem(key);
  if (v == null) throw new Error("not found");
  return { key, value: v };
};
const storageSet = async (key, value) => {
  if (IS_NATIVE) {
    await Filesystem.writeFile({ path: fileFor(key), directory: Directory.Data, encoding: Encoding.UTF8, data: value, recursive: true });
    return { key, value };
  }
  localStorage.setItem(key, value);
  return { key, value };
};

/* ---------- amount formatting ---------- */

const FRACTIONS = [
  [0.125, "⅛"], [0.25, "¼"], [0.33, "⅓"], [0.375, "⅜"], [0.5, "½"],
  [0.625, "⅝"], [0.66, "⅔"], [0.75, "¾"], [0.875, "⅞"],
];

function formatAmount(amount, unit) {
  if (amount == null) return "";
  let v = amount;
  const u = (unit || "").toLowerCase();
  if (u === "g" || u === "ml") {
    if (v >= 100) v = Math.round(v / 5) * 5;
    else if (v >= 20) v = Math.round(v);
    else v = Math.round(v * 2) / 2;
    return trimNum(v);
  }
  if (u === "kg" || u === "l") return trimNum(Math.round(v * 100) / 100);
  if (u === "tsp" || u === "tbsp" || u === "cup" || u === "cups") return toFraction(Math.round(v * 8) / 8);
  return toFraction(Math.round(v * 2) / 2);
}

function trimNum(v) {
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(2)));
}

function toFraction(v) {
  const whole = Math.floor(v);
  const frac = v - whole;
  if (frac < 0.06) return String(whole || trimNum(v));
  let best = "", bestDiff = 1;
  for (const [f, sym] of FRACTIONS) {
    const d = Math.abs(frac - f);
    if (d < bestDiff) { bestDiff = d; best = sym; }
  }
  if (bestDiff > 0.06) return trimNum(v);
  return whole ? `${whole}${best}` : best;
}

function parseIngredientLine(line) {
  const t = line.trim();
  if (!t) return null;
  const m = t.match(/^(\d+(?:[.,]\d+)?|\d+\/\d+|[¼½¾⅓⅔⅛])\s*(kg|g|ml|l|tbsp|tsp|cups|cup)?\s+(.+)$/i);
  if (!m) return { amount: null, unit: "", name: t };
  let amt = m[1].replace(",", ".");
  if (amt.includes("/")) {
    const [a, b] = amt.split("/");
    amt = parseFloat(a) / parseFloat(b);
  } else {
    const map = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 0.333, "⅔": 0.667, "⅛": 0.125 };
    amt = map[amt] ?? parseFloat(amt);
  }
  return { amount: amt, unit: m[2] ? m[2].toLowerCase() : "", name: m[3].trim() };
}

/* ---------- starter recipes ---------- */

const ing = (amount, unit, name) => ({ amount, unit, name });

const STARTERS = [
  {
    id: "starter-bolognese",
    title: "Spaghetti Bolognese",
    category: "Pasta",
    time: "45 min",
    baseServings: 4,
    ingredients: [
      ing(500, "g", "beef mince"),
      ing(1, "", "brown onion, finely diced"),
      ing(2, "", "garlic cloves, crushed"),
      ing(1, "", "carrot, finely diced"),
      ing(1, "", "celery stalk, finely diced"),
      ing(700, "g", "tomato passata"),
      ing(2, "tbsp", "tomato paste"),
      ing(125, "ml", "red wine (or beef stock)"),
      ing(1, "tsp", "dried oregano"),
      ing(400, "g", "dried spaghetti"),
      ing(null, "", "salt, pepper and parmesan, to serve"),
    ],
    steps: [
      "Heat a splash of olive oil in a large pot over medium heat. Cook the onion, carrot and celery for 5–6 minutes until soft, then add the garlic for 1 minute.",
      "Turn the heat up, add the mince and brown well, breaking it up as you go.",
      "Stir in the tomato paste and cook for 1 minute, then add the wine and let it bubble away.",
      "Add the passata and oregano, season, and simmer uncovered for 25–30 minutes until thick.",
      "Cook the spaghetti in salted boiling water until al dente. Toss through the sauce with a splash of pasta water and serve with parmesan.",
    ],
    notes: "Freezes brilliantly — portion the sauce before adding pasta.",
  },
  {
    id: "starter-butter-chicken",
    title: "Butter Chicken",
    category: "Curry",
    time: "40 min + marinating",
    baseServings: 4,
    ingredients: [
      ing(700, "g", "chicken thigh fillets, cut into chunks"),
      ing(130, "g", "plain Greek-style natural yoghurt (for marinade)"),
      ing(2, "tbsp", "tandoori or garam masala spice mix"),
      ing(50, "g", "butter"),
      ing(1, "", "brown onion, finely diced"),
      ing(2, "", "garlic cloves, crushed"),
      ing(1, "tbsp", "grated ginger"),
      ing(400, "g", "tin crushed tomatoes"),
      ing(300, "ml", "thickened cream"),
      ing(1, "tsp", "sugar"),
      ing(null, "", "steamed basmati rice, to serve"),
    ],
    steps: [
      "Mix the chicken with the yoghurt and half the spice mix. Marinate for at least 30 minutes (overnight is better).",
      "Melt half the butter in a large pan over high heat and brown the chicken in batches. Set aside.",
      "Add the remaining butter, then cook the onion until golden. Add garlic, ginger and remaining spices for 1 minute.",
      "Add the tomatoes and simmer for 10 minutes, then blend until smooth if you like a silky sauce.",
      "Return the chicken with the cream and sugar, and simmer gently for 10 minutes until cooked through. Season and serve with rice.",
    ],
    notes: "The yoghurt marinade is doing real work here — it disappears completely into the sauce.",
  },
  {
    id: "starter-pumpkin-soup",
    title: "Roast Pumpkin Soup",
    category: "Soup",
    time: "1 hr",
    baseServings: 6,
    ingredients: [
      ing(1.5, "kg", "Kent pumpkin, peeled and cut into chunks"),
      ing(1, "", "brown onion, quartered"),
      ing(3, "", "garlic cloves, unpeeled"),
      ing(2, "tbsp", "olive oil"),
      ing(1, "l", "chicken or vegetable stock"),
      ing(125, "ml", "thickened cream, plus extra to serve"),
      ing(0.5, "tsp", "ground nutmeg"),
      ing(null, "", "crusty bread, to serve"),
    ],
    steps: [
      "Preheat a fan-forced oven to 200°C. Toss the pumpkin, onion and garlic with the oil on a large tray, season, and roast for 35–40 minutes until golden.",
      "Squeeze the garlic from its skins into a large pot with the roasted vegetables.",
      "Add the stock, bring to a simmer for 5 minutes, then blend until completely smooth.",
      "Stir through the cream and nutmeg, adjust the seasoning, and serve with a swirl of extra cream and crusty bread.",
    ],
    notes: "Roasting rather than boiling the pumpkin is what gives it depth.",
  },
  {
    id: "starter-fried-rice",
    title: "Chicken Fried Rice",
    category: "Weeknight",
    time: "25 min",
    baseServings: 4,
    ingredients: [
      ing(370, "g", "jasmine rice (cooked and chilled, ideally day-old)"),
      ing(400, "g", "chicken thigh fillets, diced"),
      ing(3, "", "eggs, lightly beaten"),
      ing(150, "g", "frozen peas and corn"),
      ing(3, "", "spring onions, sliced"),
      ing(2, "", "garlic cloves, crushed"),
      ing(2, "tbsp", "soy sauce"),
      ing(1, "tbsp", "oyster sauce"),
      ing(1, "tsp", "sesame oil"),
      ing(2, "tbsp", "vegetable oil"),
    ],
    steps: [
      "Heat half the vegetable oil in a wok over high heat. Scramble the eggs, then set aside.",
      "Add the remaining oil and stir-fry the chicken until golden and cooked through. Add the garlic for 30 seconds.",
      "Add the rice and toss for 2–3 minutes, pressing it against the wok to catch a little colour.",
      "Add the peas, corn, soy, oyster sauce and sesame oil. Toss until everything is hot.",
      "Fold through the egg and spring onion and serve straight away.",
    ],
    notes: "Day-old rice is the difference between fried rice and soggy rice.",
  },
  {
    id: "starter-green-curry",
    title: "Thai Green Chicken Curry",
    category: "Curry",
    time: "35 min",
    baseServings: 4,
    ingredients: [
      ing(600, "g", "chicken thigh fillets, sliced"),
      ing(90, "g", "green curry paste"),
      ing(400, "ml", "tin coconut milk"),
      ing(250, "ml", "chicken stock"),
      ing(150, "g", "green beans, trimmed and halved"),
      ing(1, "", "small eggplant, cut into chunks (or 6 kaffir lime leaves + bamboo shoots)"),
      ing(1, "tbsp", "fish sauce"),
      ing(1, "tsp", "brown sugar"),
      ing(null, "", "Thai basil and jasmine rice, to serve"),
    ],
    steps: [
      "Spoon the thick cream from the top of the coconut milk into a hot wok and fry the curry paste in it for 2–3 minutes until fragrant and split.",
      "Add the chicken and toss to coat in the paste.",
      "Pour in the remaining coconut milk and stock, bring to a simmer, and add the eggplant.",
      "Simmer for 10 minutes, add the beans for the final 4 minutes, then season with fish sauce and sugar.",
      "Scatter with Thai basil and serve over jasmine rice.",
    ],
    notes: "Frying the paste in coconut cream (not oil) is the classic technique.",
  },
  {
    id: "starter-beef-tacos",
    title: "Beef Tacos",
    category: "Weeknight",
    time: "25 min",
    baseServings: 4,
    ingredients: [
      ing(500, "g", "beef mince"),
      ing(1, "", "brown onion, finely diced"),
      ing(2, "", "garlic cloves, crushed"),
      ing(1, "tbsp", "smoked paprika"),
      ing(2, "tsp", "ground cumin"),
      ing(1, "tsp", "dried oregano"),
      ing(2, "tbsp", "tomato paste"),
      ing(125, "ml", "beef stock or water"),
      ing(12, "", "small flour or corn tortillas"),
      ing(null, "", "shredded lettuce, cheese, sour cream, lime and hot sauce, to serve"),
    ],
    steps: [
      "Heat a splash of oil in a frypan over high heat and brown the mince well.",
      "Add the onion and cook for 3–4 minutes, then the garlic, paprika, cumin and oregano for 1 minute.",
      "Stir in the tomato paste and stock and simmer for 5 minutes until thick and glossy. Season well.",
      "Warm the tortillas in a dry pan and build tacos at the table with the toppings.",
    ],
    notes: "The homemade spice mix beats the packet stuff and takes 30 seconds.",
  },
];


/* ---------- dinner expansion: more pasta, curries, soups, stir-fries and classics ---------- */

const DINNER_RECIPES = [
  // ----- PASTA -----
  {
    id: "starter-carbonara", title: "Spaghetti Carbonara", category: "Pasta", time: "20 min", baseServings: 4,
    ingredients: [
      ing(400, "g", "dried spaghetti"), ing(200, "g", "bacon or pancetta, diced"), ing(4, "", "eggs"),
      ing(80, "g", "parmesan, finely grated, plus extra to serve"), ing(2, "", "garlic cloves, lightly crushed"),
      ing(null, "", "black pepper, lots of it"),
    ],
    steps: [
      "Cook the spaghetti in well-salted boiling water until al dente. Reserve a mug of pasta water before draining.",
      "Meanwhile, fry the bacon with the garlic cloves over medium heat until crisp. Discard the garlic, keep the fat.",
      "Whisk the eggs, parmesan and a very generous grind of pepper in a bowl.",
      "Off the heat, tip the hot drained pasta into the bacon pan, wait 30 seconds, then pour in the egg mixture, tossing constantly and adding splashes of pasta water until glossy — the residual heat cooks the egg into a silky sauce.",
      "Serve immediately with extra parmesan and pepper.",
    ],
    notes: "No cream — the sauce is just egg, cheese and pasta water. Keep the pan off direct heat or you'll make scrambled eggs.",
  },
  {
    id: "starter-garlic-prawn-pasta", title: "Creamy Garlic Prawn Pasta", category: "Pasta", time: "25 min", baseServings: 4,
    ingredients: [
      ing(400, "g", "dried linguine or fettuccine"), ing(600, "g", "raw prawns, peeled and deveined"),
      ing(4, "", "garlic cloves, crushed"), ing(40, "g", "butter"), ing(300, "ml", "thickened cream"),
      ing(125, "ml", "dry white wine (or chicken stock)"), ing(1, "", "lemon, zested and juiced"),
      ing(0.5, "tsp", "chilli flakes"), ing(null, "", "chopped parsley and parmesan, to serve"),
    ],
    steps: [
      "Cook the pasta in salted boiling water until al dente; reserve a mug of pasta water.",
      "Melt the butter in a large frypan over high heat and cook the prawns for 1–2 minutes each side until just pink. Set aside.",
      "Lower the heat, add the garlic and chilli flakes for 30 seconds, then the wine — let it bubble down by half.",
      "Stir in the cream and lemon zest and simmer for 2–3 minutes to thicken slightly.",
      "Return the prawns, toss through the pasta with lemon juice and a splash of pasta water, season, and serve with parsley and parmesan.",
    ],
    notes: "Prawns overcook fast — pull them the moment they curl and turn pink.",
  },
  {
    id: "starter-lasagne", title: "Classic Beef Lasagne", category: "Pasta", time: "1 hr 45 min", baseServings: 8,
    ingredients: [
      ing(750, "g", "beef mince"), ing(1, "", "brown onion, finely diced"), ing(1, "", "carrot, finely diced"),
      ing(3, "", "garlic cloves, crushed"), ing(700, "g", "tomato passata"), ing(2, "tbsp", "tomato paste"),
      ing(250, "ml", "beef stock"), ing(2, "tsp", "dried oregano"), ing(250, "g", "dried lasagne sheets"),
      ing(80, "g", "butter (for the white sauce)"), ing(80, "g", "plain flour"), ing(1, "l", "milk"),
      ing(150, "g", "grated tasty cheese"), ing(50, "g", "parmesan, grated"),
    ],
    steps: [
      "Brown the mince in a large pot over high heat. Add the onion, carrot and garlic and cook for 5 minutes.",
      "Stir in the tomato paste, then the passata, stock and oregano. Simmer uncovered for 30 minutes until thick. Season well.",
      "For the white sauce: melt the butter in a saucepan, stir in the flour for 1 minute, then whisk in the milk gradually. Simmer, whisking, until thickened. Season with salt and a little of the parmesan.",
      "Preheat a fan-forced oven to 180°C. In a large baking dish, layer meat sauce, lasagne sheets and white sauce; repeat, finishing with white sauce. Top with the tasty cheese and remaining parmesan.",
      "Bake for 40–45 minutes until golden and bubbling. Rest for 10 minutes before cutting.",
    ],
    notes: "Better the next day, and freezes brilliantly in portions.",
  },
  {
    id: "starter-pesto-chicken-pasta", title: "Chicken Pesto Pasta", category: "Pasta", time: "25 min", baseServings: 4,
    ingredients: [
      ing(400, "g", "dried penne"), ing(500, "g", "chicken breast, sliced"), ing(180, "g", "basil pesto"),
      ing(150, "g", "cherry tomatoes, halved"), ing(100, "ml", "thickened cream"), ing(60, "g", "baby spinach"),
      ing(null, "", "parmesan and pine nuts, to serve"),
    ],
    steps: [
      "Cook the penne in salted boiling water until al dente; reserve a mug of pasta water.",
      "Meanwhile, brown the chicken in a splash of olive oil over high heat until cooked through.",
      "Lower the heat, stir the pesto and cream into the chicken pan.",
      "Toss through the drained pasta, tomatoes and spinach with enough pasta water to make it glossy.",
      "Serve with parmesan and toasted pine nuts.",
    ],
    notes: "Good jarred pesto is fine on a weeknight; homemade lifts it on the weekend.",
  },
  {
    id: "starter-mac-cheese", title: "Baked Mac and Cheese", category: "Pasta", time: "45 min", baseServings: 6,
    ingredients: [
      ing(400, "g", "dried macaroni"), ing(60, "g", "butter"), ing(60, "g", "plain flour"), ing(750, "ml", "milk"),
      ing(250, "g", "grated tasty cheese"), ing(50, "g", "parmesan, grated"), ing(1, "tsp", "Dijon mustard"),
      ing(40, "g", "panko breadcrumbs"), ing(null, "", "salt, pepper and a pinch of nutmeg"),
    ],
    steps: [
      "Preheat a fan-forced oven to 180°C. Cook the macaroni 2 minutes short of packet time and drain.",
      "Melt the butter in a large saucepan, stir in the flour for 1 minute, then gradually whisk in the milk until smooth and thickened.",
      "Off the heat, stir in the mustard, most of the tasty cheese and half the parmesan. Season with salt, pepper and nutmeg.",
      "Fold in the macaroni, tip into a baking dish, and top with the remaining cheeses mixed with the breadcrumbs.",
      "Bake for 20–25 minutes until golden and bubbling at the edges.",
    ],
    notes: "Add crispy bacon or a handful of frozen peas to the sauce if you like.",
  },

  // ----- CURRY -----
  {
    id: "starter-massaman", title: "Beef Massaman Curry", category: "Curry", time: "2 hr 30 min", baseServings: 6,
    ingredients: [
      ing(1.2, "kg", "chuck steak, cut into large chunks"), ing(110, "g", "massaman curry paste"),
      ing(800, "ml", "coconut milk (two tins)"), ing(500, "g", "baby potatoes, halved"),
      ing(1, "", "brown onion, cut into wedges"), ing(80, "g", "roasted peanuts"),
      ing(2, "tbsp", "fish sauce"), ing(2, "tbsp", "brown sugar"), ing(2, "tbsp", "tamarind puree"),
      ing(2, "", "cinnamon sticks"), ing(null, "", "jasmine rice, to serve"),
    ],
    steps: [
      "Fry the curry paste in the thick coconut cream from the top of one tin over medium-high heat until fragrant and split.",
      "Add the beef and toss to coat, then pour in the remaining coconut milk, fish sauce, sugar, tamarind and cinnamon.",
      "Cover and simmer gently for 1½ hours, stirring occasionally.",
      "Add the potatoes, onion and half the peanuts and simmer uncovered for another 45 minutes until the beef is fork-tender and the sauce has thickened.",
      "Check the balance — it should be rich, slightly sweet and sour. Serve over rice scattered with the remaining peanuts.",
    ],
    notes: "Even better the next day. Slow cooker: 8 hours on low, potatoes in for the last 2.",
  },
  {
    id: "starter-curried-sausages", title: "Curried Sausages", category: "Curry", time: "40 min", baseServings: 4,
    ingredients: [
      ing(8, "", "thick beef sausages"), ing(1, "", "brown onion, sliced"), ing(2, "", "carrots, sliced"),
      ing(150, "g", "frozen peas"), ing(2, "tbsp", "curry powder"), ing(2, "tbsp", "plain flour"),
      ing(500, "ml", "beef stock"), ing(1, "tbsp", "fruit chutney or apricot jam"),
      ing(null, "", "mashed potato or rice, to serve"),
    ],
    steps: [
      "Simmer the sausages in water for 10 minutes, then drain, cool slightly and slice thickly.",
      "Brown the onion and carrot in a little oil in the same pan for 5 minutes.",
      "Stir in the curry powder and flour for 1 minute, then gradually add the stock, stirring until smooth.",
      "Return the sausages with the chutney and simmer for 10 minutes until the sauce thickens. Add the peas for the final 3 minutes.",
      "Season and serve over mash or rice.",
    ],
    notes: "A true Aussie classic — the chutney is the secret handshake.",
  },
  {
    id: "starter-chickpea-curry", title: "Chickpea & Spinach Curry", category: "Curry", time: "30 min", baseServings: 4,
    ingredients: [
      ing(800, "g", "tinned chickpeas, drained (two tins)"), ing(400, "g", "tin crushed tomatoes"),
      ing(400, "ml", "tin coconut milk"), ing(1, "", "brown onion, finely diced"),
      ing(3, "", "garlic cloves, crushed"), ing(1, "tbsp", "grated ginger"), ing(2, "tbsp", "curry powder"),
      ing(1, "tsp", "ground cumin"), ing(120, "g", "baby spinach"), ing(1, "", "lemon, juiced"),
      ing(null, "", "rice and natural yoghurt, to serve"),
    ],
    steps: [
      "Cook the onion in a little oil over medium heat for 5 minutes, then add the garlic, ginger and spices for 1 minute until fragrant.",
      "Add the tomatoes and coconut milk and simmer for 5 minutes.",
      "Stir in the chickpeas and simmer for 12–15 minutes until the sauce thickens, mashing a few chickpeas against the pot to help it along.",
      "Fold in the spinach until wilted, season with salt and lemon juice, and serve with rice.",
    ],
    notes: "A pantry dinner — everything but the spinach keeps in the cupboard.",
  },
  {
    id: "starter-rogan-josh", title: "Lamb Rogan Josh", category: "Curry", time: "2 hr", baseServings: 6,
    ingredients: [
      ing(1.2, "kg", "lamb shoulder, cut into chunks"), ing(140, "g", "rogan josh paste"),
      ing(2, "", "brown onions, sliced"), ing(400, "g", "tin crushed tomatoes"),
      ing(200, "g", "natural yoghurt, plus extra to serve"), ing(250, "ml", "beef or chicken stock"),
      ing(4, "", "cardamom pods, bruised"), ing(null, "", "steamed basmati rice and coriander, to serve"),
    ],
    steps: [
      "Brown the lamb in batches in a large pot over high heat. Set aside.",
      "Cook the onions in the same pot for 8 minutes until golden, then add the paste and cardamom for 2 minutes.",
      "Return the lamb with the tomatoes and stock. Cover and simmer gently for 1½ hours, stirring now and then, until the lamb is tender.",
      "Uncover for the last 20 minutes to thicken. Stir through the yoghurt off the heat, season, and serve with rice, coriander and extra yoghurt.",
    ],
    notes: "Stir yoghurt in off the heat so it doesn't split.",
  },
  {
    id: "starter-katsu-curry", title: "Chicken Katsu Curry", category: "Curry", time: "45 min", baseServings: 4,
    ingredients: [
      ing(4, "", "chicken breast fillets, flattened slightly"), ing(100, "g", "plain flour"),
      ing(2, "", "eggs, beaten"), ing(150, "g", "panko breadcrumbs"),
      ing(1, "", "brown onion, diced"), ing(1, "", "carrot, diced"), ing(2, "tbsp", "curry powder"),
      ing(2, "tbsp", "plain flour, extra (for the sauce)"), ing(600, "ml", "chicken stock"),
      ing(1, "tbsp", "soy sauce"), ing(2, "tsp", "honey"), ing(null, "", "steamed rice and shredded cabbage, to serve"),
    ],
    steps: [
      "For the sauce: cook the onion and carrot in a little oil for 6 minutes. Stir in the curry powder and extra flour for 1 minute, then whisk in the stock gradually. Simmer for 10 minutes, add soy and honey, then blend until smooth.",
      "Crumb the chicken: flour, then egg, then panko, pressing the crumbs on.",
      "Shallow-fry in 1 cm of oil over medium-high heat for 3–4 minutes each side until deep golden and cooked through. Drain on paper towel.",
      "Slice the chicken, lay over rice with cabbage, and pour the curry sauce across the middle.",
    ],
    notes: "The sauce freezes well — make double and future-you eats katsu in 15 minutes.",
  },

  // ----- SOUP -----
  {
    id: "starter-chicken-noodle-soup", title: "Chicken Noodle Soup", category: "Soup", time: "40 min", baseServings: 6,
    ingredients: [
      ing(500, "g", "chicken thigh fillets"), ing(1.5, "l", "chicken stock"), ing(1, "", "brown onion, diced"),
      ing(2, "", "carrots, sliced"), ing(2, "", "celery stalks, sliced"), ing(2, "", "garlic cloves, crushed"),
      ing(150, "g", "dried egg noodles or vermicelli"), ing(1, "tbsp", "olive oil"),
      ing(null, "", "parsley and lemon, to serve"),
    ],
    steps: [
      "Soften the onion, carrot and celery in the oil in a large pot for 6 minutes; add the garlic for 1 minute.",
      "Add the stock and whole chicken thighs and simmer gently for 20 minutes.",
      "Lift out the chicken, shred with two forks, and return it to the pot.",
      "Add the noodles and cook until just tender. Season, and serve with parsley and a squeeze of lemon.",
    ],
    notes: "The soup that fixes most things. Freeze it without the noodles and add fresh ones when reheating.",
  },
  {
    id: "starter-minestrone", title: "Minestrone", category: "Soup", time: "50 min", baseServings: 6,
    ingredients: [
      ing(1, "", "brown onion, diced"), ing(2, "", "carrots, diced"), ing(2, "", "celery stalks, diced"),
      ing(2, "", "garlic cloves, crushed"), ing(100, "g", "bacon, diced (optional)"),
      ing(400, "g", "tin crushed tomatoes"), ing(1.25, "l", "chicken or vegetable stock"),
      ing(400, "g", "tin cannellini or borlotti beans, drained"), ing(100, "g", "small dried pasta (ditalini or macaroni)"),
      ing(1, "", "zucchini, diced"), ing(80, "g", "green beans, chopped"),
      ing(null, "", "parmesan and crusty bread, to serve"),
    ],
    steps: [
      "Cook the onion, carrot, celery and bacon in olive oil over medium heat for 8 minutes until soft. Add the garlic for 1 minute.",
      "Add the tomatoes and stock and simmer for 15 minutes.",
      "Add the pasta, tinned beans, zucchini and green beans and simmer for another 10–12 minutes until the pasta is tender.",
      "Season generously and serve with grated parmesan and bread.",
    ],
    notes: "A fridge-clearing soup — swap in whatever veg is looking at you.",
  },
  {
    id: "starter-potato-leek", title: "Potato & Leek Soup", category: "Soup", time: "40 min", baseServings: 6,
    ingredients: [
      ing(1, "kg", "potatoes, peeled and chopped"), ing(2, "", "leeks, white parts sliced and washed well"),
      ing(40, "g", "butter"), ing(2, "", "garlic cloves, crushed"), ing(1.25, "l", "chicken or vegetable stock"),
      ing(125, "ml", "thickened cream"), ing(null, "", "chives and crusty bread, to serve"),
    ],
    steps: [
      "Melt the butter in a large pot and cook the leeks gently for 8–10 minutes until silky, without browning. Add the garlic for 1 minute.",
      "Add the potatoes and stock, bring to a simmer, and cook for 20 minutes until the potato collapses.",
      "Blend until completely smooth, stir through the cream, and season well.",
      "Serve with snipped chives and bread.",
    ],
    notes: "Wash leeks thoroughly — grit hides between the layers.",
  },
  {
    id: "starter-pea-ham-soup", title: "Pea & Ham Soup", category: "Soup", time: "2 hr", baseServings: 8,
    ingredients: [
      ing(500, "g", "dried green split peas, rinsed"), ing(1, "", "ham hock (about 800 g)"),
      ing(1, "", "brown onion, diced"), ing(2, "", "carrots, diced"), ing(2, "", "celery stalks, diced"),
      ing(2, "", "garlic cloves, crushed"), ing(2, "l", "water or chicken stock"), ing(2, "", "bay leaves"),
    ],
    steps: [
      "Soften the onion, carrot and celery in a little oil in a large pot for 6 minutes; add the garlic for 1 minute.",
      "Add the split peas, ham hock, bay leaves and water. Bring to a simmer.",
      "Simmer gently, partly covered, for 1½–2 hours, stirring occasionally, until the peas have collapsed and the ham is falling off the bone.",
      "Lift out the hock, shred the meat, discard skin and bone, and return the meat to the pot. Season with pepper (the ham usually brings enough salt).",
    ],
    notes: "Thickens dramatically overnight — loosen leftovers with a splash of water.",
  },
  {
    id: "starter-laksa", title: "Chicken Laksa", category: "Soup", time: "35 min", baseServings: 4,
    ingredients: [
      ing(500, "g", "chicken thigh fillets, sliced"), ing(185, "g", "laksa paste"),
      ing(400, "ml", "tin coconut milk"), ing(750, "ml", "chicken stock"),
      ing(200, "g", "dried rice vermicelli"), ing(150, "g", "fried tofu puffs, halved"),
      ing(100, "g", "bean sprouts"), ing(1, "tbsp", "fish sauce"), ing(1, "tsp", "brown sugar"),
      ing(null, "", "lime, coriander and sliced chilli, to serve"),
    ],
    steps: [
      "Fry the laksa paste in a little oil in a large pot for 2 minutes until fragrant.",
      "Add the chicken and toss to coat, then pour in the coconut milk and stock. Simmer for 12 minutes.",
      "Meanwhile, soak the vermicelli in boiling water until tender; drain and divide between bowls.",
      "Season the soup with fish sauce and sugar, add the tofu puffs for the final 2 minutes, then ladle over the noodles.",
      "Top with bean sprouts, coriander, chilli and a big squeeze of lime.",
    ],
    notes: "Tofu puffs soak up the broth like sponges — don't skip them.",
  },

  // ----- STIR-FRY -----
  {
    id: "starter-beef-broccoli", title: "Beef & Broccoli Stir-fry", category: "Stir-fry", time: "25 min", baseServings: 4,
    ingredients: [
      ing(500, "g", "rump or sirloin steak, thinly sliced against the grain"),
      ing(1, "", "large head broccoli, cut into florets"), ing(3, "", "garlic cloves, crushed"),
      ing(1, "tbsp", "grated ginger"), ing(3, "tbsp", "oyster sauce"), ing(2, "tbsp", "soy sauce"),
      ing(1, "tbsp", "cornflour"), ing(125, "ml", "chicken stock or water"), ing(1, "tsp", "sesame oil"),
      ing(2, "tbsp", "vegetable oil"), ing(null, "", "steamed rice, to serve"),
    ],
    steps: [
      "Toss the beef with the cornflour and 1 tbsp of the soy. Mix the remaining soy, oyster sauce, stock and sesame oil for the sauce.",
      "Blanch the broccoli in boiling water for 90 seconds; drain.",
      "Heat a wok until smoking, add half the oil, and sear the beef in two batches until browned but not cooked through. Set aside.",
      "Add the remaining oil, then the garlic and ginger for 20 seconds. Return the beef with the broccoli and sauce and toss for 1–2 minutes until glossy and thickened.",
      "Serve immediately over rice.",
    ],
    notes: "Slice the beef when slightly frozen for paper-thin pieces, and never crowd the wok.",
  },
  {
    id: "starter-honey-soy-chicken", title: "Honey Soy Chicken Stir-fry", category: "Stir-fry", time: "25 min", baseServings: 4,
    ingredients: [
      ing(600, "g", "chicken thigh fillets, sliced"), ing(1, "", "red capsicum, sliced"),
      ing(1, "", "carrot, cut into matchsticks"), ing(150, "g", "snow peas, trimmed"),
      ing(3, "", "spring onions, cut into lengths"), ing(2, "", "garlic cloves, crushed"),
      ing(3, "tbsp", "honey"), ing(3, "tbsp", "soy sauce"), ing(1, "tbsp", "rice vinegar"),
      ing(1, "tbsp", "cornflour mixed with 60 ml water"), ing(2, "tbsp", "vegetable oil"),
      ing(null, "", "steamed rice and sesame seeds, to serve"),
    ],
    steps: [
      "Mix the honey, soy and vinegar for the sauce.",
      "Heat a wok until very hot, add half the oil, and stir-fry the chicken in two batches until golden. Set aside.",
      "Add the remaining oil, then the carrot and capsicum for 2 minutes, the snow peas and garlic for 1 minute more.",
      "Return the chicken with the sauce, bring to a bubble, then stir in the cornflour slurry until glossy.",
      "Toss through the spring onions and serve over rice with sesame seeds.",
    ],
    notes: "The slurry at the end is what turns it from watery to takeaway-glossy.",
  },
  {
    id: "starter-mongolian-beef", title: "Mongolian Beef", category: "Stir-fry", time: "25 min", baseServings: 4,
    ingredients: [
      ing(600, "g", "rump steak, thinly sliced"), ing(60, "g", "cornflour"),
      ing(4, "", "spring onions, cut into 4 cm lengths"), ing(3, "", "garlic cloves, crushed"),
      ing(1, "tbsp", "grated ginger"), ing(80, "ml", "soy sauce"), ing(60, "g", "brown sugar"),
      ing(80, "ml", "water"), ing(80, "ml", "vegetable oil"), ing(null, "", "steamed rice, to serve"),
    ],
    steps: [
      "Toss the beef in the cornflour, shaking off the excess.",
      "Heat the oil in a wok over high heat and fry the beef in batches for 2 minutes each until crisp at the edges. Drain on paper towel; pour off all but 1 tbsp oil.",
      "Stir-fry the garlic and ginger for 20 seconds, then add the soy, sugar and water and bubble for 2 minutes until syrupy.",
      "Return the beef with the spring onions and toss until every piece is lacquered. Serve over rice.",
    ],
    notes: "Sweet, sticky and gone in minutes — a little sauce goes a long way over rice.",
  },
  {
    id: "starter-cashew-chicken", title: "Chicken Cashew Stir-fry", category: "Stir-fry", time: "25 min", baseServings: 4,
    ingredients: [
      ing(600, "g", "chicken breast, diced"), ing(100, "g", "roasted cashews"),
      ing(1, "", "red capsicum, diced"), ing(1, "", "brown onion, cut into wedges"),
      ing(2, "", "garlic cloves, crushed"), ing(2, "tbsp", "oyster sauce"), ing(1, "tbsp", "soy sauce"),
      ing(1, "tbsp", "hoisin sauce"), ing(80, "ml", "chicken stock"), ing(2, "tbsp", "vegetable oil"),
      ing(null, "", "steamed rice, to serve"),
    ],
    steps: [
      "Mix the oyster, soy and hoisin sauces with the stock.",
      "Heat a wok until smoking, add half the oil and stir-fry the chicken in batches until golden. Set aside.",
      "Add the remaining oil, then the onion and capsicum for 2 minutes and the garlic for 30 seconds.",
      "Return the chicken with the sauce and cashews and toss for 1–2 minutes until coated and bubbling. Serve over rice.",
    ],
    notes: "Toast the cashews in the dry wok first for extra crunch and flavour.",
  },
  {
    id: "starter-veg-noodle-stirfry", title: "Sweet Chilli Veggie Noodle Stir-fry", category: "Stir-fry", time: "20 min", baseServings: 4,
    ingredients: [
      ing(440, "g", "fresh hokkien noodles"), ing(1, "", "red capsicum, sliced"),
      ing(1, "", "carrot, cut into matchsticks"), ing(150, "g", "broccoli florets"),
      ing(100, "g", "snow peas"), ing(2, "", "eggs, lightly beaten"),
      ing(3, "tbsp", "sweet chilli sauce"), ing(2, "tbsp", "soy sauce"), ing(1, "", "lime, juiced"),
      ing(2, "tbsp", "vegetable oil"), ing(null, "", "coriander and crushed peanuts, to serve"),
    ],
    steps: [
      "Cover the noodles with boiling water for 2 minutes, then drain and separate.",
      "Heat half the oil in a wok, scramble the eggs, and set aside.",
      "Add the remaining oil and stir-fry the carrot, capsicum and broccoli for 3 minutes, then the snow peas for 1 minute.",
      "Add the noodles, sweet chilli, soy and lime juice and toss until hot. Fold through the egg.",
      "Serve topped with coriander and peanuts.",
    ],
    notes: "Meat-free Monday sorted — add tofu or leftover shredded chicken if you like.",
  },

  // ----- CLASSICS -----
  {
    id: "starter-roast-chicken", title: "Roast Chicken with Vegetables", category: "Roast", time: "1 hr 30 min", baseServings: 4,
    ingredients: [
      ing(1.8, "kg", "whole chicken"), ing(50, "g", "butter, softened"), ing(1, "", "lemon, halved"),
      ing(4, "", "garlic cloves, unpeeled"), ing(800, "g", "potatoes, chopped into chunks"),
      ing(400, "g", "pumpkin, chopped"), ing(2, "", "carrots, halved lengthways"),
      ing(2, "tbsp", "olive oil"), ing(2, "tsp", "fresh thyme or rosemary leaves"),
    ],
    steps: [
      "Preheat a fan-forced oven to 200°C. Pat the chicken very dry, rub all over with the butter, season generously, and put the lemon halves and garlic in the cavity.",
      "Toss the vegetables with the oil and herbs in a large roasting pan, season, and sit the chicken on top.",
      "Roast for 60–70 minutes, until the juices run clear when the thickest part of the thigh is pierced (75°C internal).",
      "Rest the chicken under foil for 10–15 minutes while the vegetables get a final 10 minutes in the oven.",
      "Carve and serve with the roast veg and the lemony pan juices.",
    ],
    notes: "A dry skin is a crispy skin — pat it down properly and don't skip the rest.",
  },
  {
    id: "starter-chicken-parmy", title: "Chicken Parmigiana", category: "Weeknight", time: "45 min", baseServings: 4,
    ingredients: [
      ing(4, "", "chicken breast fillets, butterflied and flattened"), ing(100, "g", "plain flour"),
      ing(2, "", "eggs, beaten"), ing(150, "g", "panko breadcrumbs"), ing(50, "g", "parmesan, grated (into the crumbs)"),
      ing(250, "g", "tomato passata"), ing(1, "tsp", "dried oregano"), ing(150, "g", "shredded mozzarella"),
      ing(100, "g", "sliced ham (optional, for the full pub experience)"),
      ing(null, "", "chips and salad, to serve — obviously"),
    ],
    steps: [
      "Preheat a fan-forced oven to 200°C (grill function if you have it). Crumb the chicken: flour, egg, then the panko mixed with parmesan.",
      "Shallow-fry in 1 cm of oil over medium-high heat for 3 minutes each side until golden. Drain and lay in a baking dish.",
      "Simmer the passata with the oregano for 5 minutes and season.",
      "Top each schnitzel with sauce, ham if using, and mozzarella. Bake or grill for 8–10 minutes until melted and bubbling.",
      "Serve with chips and salad, and defend your position on whether the chips go under the parmy.",
    ],
    notes: "Skip steps 3–4 and you've got a perfect chicken schnitzel — one recipe, two dinners.",
  },
  {
    id: "starter-shepherds-pie", title: "Shepherd's Pie", category: "Weeknight", time: "1 hr 15 min", baseServings: 6,
    ingredients: [
      ing(750, "g", "lamb mince (beef makes it a cottage pie)"), ing(1, "", "brown onion, diced"),
      ing(2, "", "carrots, diced"), ing(2, "", "garlic cloves, crushed"), ing(2, "tbsp", "tomato paste"),
      ing(1, "tbsp", "Worcestershire sauce"), ing(375, "ml", "beef stock"), ing(150, "g", "frozen peas"),
      ing(1, "kg", "potatoes, peeled and chopped"), ing(60, "g", "butter"), ing(125, "ml", "milk"),
      ing(60, "g", "grated tasty cheese"),
    ],
    steps: [
      "Brown the mince in a large pan over high heat. Add the onion, carrot and garlic and cook for 5 minutes.",
      "Stir in the tomato paste and Worcestershire, then the stock. Simmer for 20 minutes until thick, adding the peas at the end. Season well.",
      "Meanwhile, boil the potatoes until tender, then mash with the butter and milk until smooth. Season.",
      "Preheat a fan-forced oven to 200°C. Spoon the mince into a baking dish, top with the mash, rough up the surface with a fork and scatter with cheese.",
      "Bake for 25 minutes until golden and bubbling at the edges.",
    ],
    notes: "The fork-roughed peaks are where the crispy bits live.",
  },
  {
    id: "starter-bangers-mash", title: "Bangers and Mash with Onion Gravy", category: "Weeknight", time: "40 min", baseServings: 4,
    ingredients: [
      ing(8, "", "good pork or beef sausages"), ing(1, "kg", "potatoes, peeled and chopped"),
      ing(80, "g", "butter"), ing(125, "ml", "milk, warmed"), ing(2, "", "brown onions, thinly sliced"),
      ing(1, "tbsp", "plain flour"), ing(375, "ml", "beef stock"), ing(1, "tsp", "Worcestershire sauce"),
      ing(null, "", "steamed greens, to serve"),
    ],
    steps: [
      "Boil the potatoes until tender, then mash with 50 g of the butter and the warm milk. Season and keep warm.",
      "Meanwhile, cook the sausages in a frypan over medium heat, turning, for 12–15 minutes. Rest on a plate.",
      "In the same pan, cook the onions in the remaining butter for 10 minutes until deep golden.",
      "Stir in the flour for 1 minute, then gradually add the stock and Worcestershire, stirring into a glossy gravy. Season.",
      "Pile mash onto plates, top with sausages, and drown the lot in onion gravy.",
    ],
    notes: "The gravy picks up all the sausage fond in the pan — don't wash it between steps.",
  },
  {
    id: "starter-rissoles", title: "Beef Rissoles", category: "Weeknight", time: "35 min", baseServings: 4,
    ingredients: [
      ing(600, "g", "beef mince"), ing(1, "", "brown onion, grated"), ing(1, "", "carrot, grated"),
      ing(1, "", "zucchini, grated and squeezed dry"), ing(1, "", "egg"), ing(60, "g", "breadcrumbs"),
      ing(2, "tbsp", "barbecue or tomato sauce, plus extra to serve"), ing(2, "tsp", "Worcestershire sauce"),
      ing(null, "", "mash or salad, to serve"),
    ],
    steps: [
      "Mix everything in a large bowl with clean hands until just combined — don't overwork it.",
      "Shape into 8 thick patties and rest in the fridge for 10 minutes if you have time.",
      "Heat a little oil in a large frypan over medium heat and cook the rissoles for 5–6 minutes each side until browned and cooked through.",
      "Serve with mash or salad and extra sauce.",
    ],
    notes: "The grated veg keeps them juicy and smuggles in a serve of vegetables.",
  },
  {
    id: "starter-fish-chips", title: "Oven-Baked Fish and Chips", category: "Weeknight", time: "50 min", baseServings: 4,
    ingredients: [
      ing(700, "g", "firm white fish fillets (flathead, ling or barramundi)"),
      ing(1, "kg", "potatoes, cut into thick chips"), ing(100, "g", "panko breadcrumbs"),
      ing(50, "g", "plain flour"), ing(2, "", "eggs, beaten"), ing(1, "", "lemon, zested (into the crumbs) and cut into wedges"),
      ing(3, "tbsp", "olive oil"), ing(null, "", "tartare sauce and a green salad, to serve"),
    ],
    steps: [
      "Preheat a fan-forced oven to 210°C. Toss the chips with 2 tbsp of the oil and plenty of salt on a large tray and bake for 20 minutes.",
      "Mix the panko with the lemon zest and remaining oil. Crumb the fish: flour, egg, then the panko mix, pressing it on.",
      "Turn the chips, make room on the tray (or use a second one), and add the fish.",
      "Bake for 12–15 minutes until the fish is golden and flakes easily and the chips are crisp.",
      "Serve with lemon wedges, tartare and salad.",
    ],
    notes: "Oiling the crumbs before they go on is the trick to oven crumbing that actually crisps.",
  },
  {
    id: "starter-honey-mustard-traybake", title: "Honey Mustard Chicken Tray Bake", category: "Weeknight", time: "55 min", baseServings: 4,
    ingredients: [
      ing(8, "", "chicken thigh fillets or drumsticks"), ing(600, "g", "baby potatoes, halved"),
      ing(2, "", "red onions, cut into wedges"), ing(200, "g", "green beans, trimmed"),
      ing(3, "tbsp", "honey"), ing(2, "tbsp", "Dijon mustard"), ing(1, "tbsp", "wholegrain mustard"),
      ing(3, "", "garlic cloves, crushed"), ing(2, "tbsp", "olive oil"), ing(1, "", "lemon, juiced"),
    ],
    steps: [
      "Preheat a fan-forced oven to 200°C. Whisk the honey, both mustards, garlic, oil and lemon juice.",
      "Toss the chicken, potatoes and onion with the marinade in a large roasting pan and spread out in one layer.",
      "Roast for 35 minutes, basting once.",
      "Scatter the beans over, toss briefly in the pan juices, and roast for a final 10 minutes.",
      "Season and serve straight from the tray, spooning the sticky juices over everything.",
    ],
    notes: "One tray, no thinking — the app's easiest 'looks like you tried' dinner.",
  },

  // ----- MORE PASTA -----
  { id: "starter-tuna-mornay", title: "Tuna Mornay Pasta Bake", category: "Pasta", time: "50 min", baseServings: 6,
    ingredients: [ing(400, "g", "dried penne"), ing(425, "g", "tin tuna in springwater, drained"), ing(60, "g", "butter"), ing(60, "g", "plain flour"), ing(750, "ml", "milk"), ing(150, "g", "grated tasty cheese"), ing(150, "g", "frozen peas and corn"), ing(1, "tsp", "Dijon mustard"), ing(40, "g", "panko breadcrumbs"), ing(1, "", "lemon, zested")],
    steps: ["Preheat a fan-forced oven to 180°C. Cook the penne 2 minutes short of packet time; drain.", "Melt the butter, stir in the flour for 1 minute, then whisk in the milk gradually until thick and smooth. Stir in the mustard and most of the cheese; season.", "Fold in the pasta, tuna, peas and corn and lemon zest, then tip into a baking dish.", "Top with the remaining cheese mixed with the breadcrumbs and bake for 20–25 minutes until golden."],
    notes: "The great Australian pantry dinner — tinned tuna's finest hour." },
  { id: "starter-mushroom-fettuccine", title: "Creamy Mushroom Fettuccine", category: "Pasta", time: "25 min", baseServings: 4,
    ingredients: [ing(400, "g", "dried fettuccine"), ing(500, "g", "mixed mushrooms, sliced"), ing(40, "g", "butter"), ing(3, "", "garlic cloves, crushed"), ing(250, "ml", "thickened cream"), ing(1, "tsp", "fresh thyme leaves"), ing(50, "g", "parmesan, grated"), ing(null, "", "salt, pepper and extra parmesan, to serve")],
    steps: ["Cook the fettuccine in salted boiling water until al dente; reserve a mug of pasta water.", "Cook the mushrooms in the butter over high heat, undisturbed at first, until deeply golden — 6–8 minutes.", "Add the garlic and thyme for 1 minute, then the cream, and simmer for 2 minutes.", "Toss through the pasta, parmesan and enough pasta water to make it silky. Season generously with pepper."],
    notes: "Golden mushrooms, not grey ones — hot pan, don't stir too early." },
  { id: "starter-sausage-ragu", title: "Sausage Ragu Rigatoni", category: "Pasta", time: "40 min", baseServings: 4,
    ingredients: [ing(500, "g", "good pork sausages, skins removed"), ing(400, "g", "dried rigatoni"), ing(1, "", "brown onion, finely diced"), ing(3, "", "garlic cloves, crushed"), ing(1, "tsp", "fennel seeds"), ing(0.5, "tsp", "chilli flakes"), ing(700, "g", "tomato passata"), ing(125, "ml", "red wine (or beef stock)"), ing(null, "", "parmesan and basil, to serve")],
    steps: ["Squeeze the sausage meat into a hot, oiled pan and brown well, breaking it into rough chunks.", "Add the onion for 4 minutes, then the garlic, fennel seeds and chilli for 1 minute.", "Pour in the wine and let it bubble away, then add the passata and simmer for 20 minutes until rich.", "Cook the rigatoni until al dente and toss through the ragu with a splash of pasta water. Serve with parmesan and basil."],
    notes: "Sausages are pre-seasoned mince — instant depth with zero effort." },
  { id: "starter-gnocchi-spinach", title: "Garlic Butter Gnocchi with Spinach", category: "Pasta", time: "20 min", baseServings: 4,
    ingredients: [ing(500, "g", "packet potato gnocchi"), ing(80, "g", "butter"), ing(4, "", "garlic cloves, sliced"), ing(120, "g", "baby spinach"), ing(150, "g", "cherry tomatoes, halved"), ing(1, "", "lemon, juiced"), ing(50, "g", "parmesan, grated"), ing(0.5, "tsp", "chilli flakes")],
    steps: ["Boil the gnocchi until they float; drain, reserving a little water.", "Melt the butter in a large frypan over medium-high heat and cook until it smells nutty and turns light brown.", "Add the garlic and chilli for 30 seconds, then the gnocchi and tomatoes — toss for 2 minutes so the gnocchi catch a little colour.", "Fold in the spinach until wilted, add lemon juice and parmesan, and loosen with a splash of gnocchi water."],
    notes: "Twenty minutes, one pan after the pot — a proper Tuesday hero." },

  // ----- MORE CURRY -----
  { id: "starter-korma", title: "Chicken Korma", category: "Curry", time: "45 min", baseServings: 4,
    ingredients: [ing(700, "g", "chicken thigh fillets, cut into chunks"), ing(1, "", "brown onion, finely diced"), ing(3, "", "garlic cloves, crushed"), ing(1, "tbsp", "grated ginger"), ing(90, "g", "korma paste"), ing(400, "ml", "coconut cream"), ing(100, "g", "natural yoghurt"), ing(40, "g", "ground almonds"), ing(1, "tsp", "sugar"), ing(null, "", "basmati rice and flaked almonds, to serve")],
    steps: ["Cook the onion gently in oil for 8 minutes until golden, then add the garlic, ginger and korma paste for 2 minutes.", "Add the chicken and toss to coat.", "Stir in the coconut cream and ground almonds and simmer gently for 20 minutes until the chicken is cooked and the sauce thick.", "Off the heat, stir through the yoghurt and sugar, season, and serve scattered with flaked almonds."],
    notes: "Mild, creamy and the reliable crowd-pleaser when chilli tolerance varies." },
  { id: "starter-dhal", title: "Red Lentil Dhal", category: "Curry", time: "35 min", baseServings: 4,
    ingredients: [ing(300, "g", "red lentils, rinsed"), ing(1, "", "brown onion, finely diced"), ing(3, "", "garlic cloves, crushed"), ing(1, "tbsp", "grated ginger"), ing(2, "tsp", "ground turmeric"), ing(2, "tsp", "ground cumin"), ing(400, "ml", "tin coconut milk"), ing(500, "ml", "vegetable stock"), ing(1, "", "lemon, juiced"), ing(40, "g", "butter (for the tarka)"), ing(2, "tsp", "cumin seeds"), ing(null, "", "rice, yoghurt and coriander, to serve")],
    steps: ["Soften the onion in oil for 5 minutes, then add the garlic, ginger and ground spices for 1 minute.", "Add the lentils, coconut milk and stock. Simmer, stirring now and then, for 20–25 minutes until collapsed and creamy.", "Season with salt and lemon juice.", "For the tarka: melt the butter in a small pan until foaming, add the cumin seeds for 30 seconds, and pour the sizzling lot over the dhal at the table."],
    notes: "Costs about $2 a serve and tastes like it cost more — the sizzling butter finish is mandatory." },
  { id: "starter-rendang", title: "Beef Rendang", category: "Curry", time: "3 hr", baseServings: 6,
    ingredients: [ing(1.2, "kg", "chuck steak, cut into large chunks"), ing(150, "g", "rendang curry paste"), ing(800, "ml", "coconut milk (two tins)"), ing(40, "g", "desiccated coconut, toasted"), ing(2, "", "kaffir lime leaves (or 1 tsp lime zest)"), ing(1, "", "cinnamon stick"), ing(1, "tbsp", "brown sugar"), ing(1, "tbsp", "fish sauce"), ing(null, "", "jasmine rice, to serve")],
    steps: ["Fry the paste in a little oil in a wide heavy pot for 2–3 minutes until fragrant.", "Add the beef, coconut milk, lime leaves and cinnamon and bring to a gentle simmer.", "Simmer uncovered, stirring occasionally (more often near the end), for 2½–3 hours. The sauce reduces from soup, to gravy, to a dark paste that fries in its own split oil — that last stage is rendang.", "Stir in the toasted coconut, sugar and fish sauce, and cook 5 more minutes. Serve with rice."],
    notes: "Don't rush the final hour — the magic is in the dry, dark, caramelised finish. A wide cast-iron pot is perfect." },

  // ----- MORE SOUP -----
  { id: "starter-tomato-soup", title: "Creamy Tomato Soup", category: "Soup", time: "35 min", baseServings: 4,
    ingredients: [ing(800, "g", "tinned crushed tomatoes (two tins)"), ing(1, "", "brown onion, diced"), ing(1, "", "carrot, diced"), ing(2, "", "garlic cloves, crushed"), ing(500, "ml", "chicken or vegetable stock"), ing(1, "tbsp", "tomato paste"), ing(1, "tsp", "sugar"), ing(100, "ml", "thickened cream"), ing(null, "", "basil and cheese toasties, to serve")],
    steps: ["Soften the onion and carrot in olive oil for 6 minutes, adding the garlic for the last minute.", "Stir in the tomato paste, then the tomatoes, stock and sugar. Simmer for 20 minutes.", "Blend until completely smooth, stir through the cream, and season well.", "Serve with torn basil and, non-negotiably, cheese toasties for dunking."],
    notes: "The sugar isn't optional — it rounds out tinned tomatoes' acidity." },
  { id: "starter-french-onion", title: "French Onion Soup", category: "Soup", time: "1 hr 15 min", baseServings: 4,
    ingredients: [ing(1, "kg", "brown onions, thinly sliced"), ing(60, "g", "butter"), ing(1, "tbsp", "plain flour"), ing(125, "ml", "dry white wine"), ing(1.25, "l", "beef stock"), ing(2, "tsp", "fresh thyme leaves"), ing(1, "", "baguette, sliced"), ing(120, "g", "gruyère or tasty cheese, grated")],
    steps: ["Melt the butter in a heavy pot and cook the onions with a pinch of salt over medium-low heat, stirring often, for 40–45 minutes until deep golden brown. This step is the entire soup — don't rush it.", "Stir in the flour for 1 minute, add the wine and bubble it down, then the stock and thyme. Simmer for 15 minutes; season.", "Toast the baguette slices, top with cheese, and grill until molten.", "Ladle the soup into bowls and float the cheese toasts on top."],
    notes: "A cast-iron dutch oven's even heat makes the long onion stage much more forgiving." },
  { id: "starter-beef-veg-soup", title: "Chunky Beef & Vegetable Soup", category: "Soup", time: "2 hr 15 min", baseServings: 6,
    ingredients: [ing(700, "g", "gravy beef or chuck, diced"), ing(1, "", "brown onion, diced"), ing(2, "", "carrots, chopped"), ing(2, "", "celery stalks, chopped"), ing(400, "g", "potatoes, diced"), ing(300, "g", "pumpkin, diced"), ing(400, "g", "tin crushed tomatoes"), ing(1.5, "l", "beef stock"), ing(80, "g", "pearl barley, rinsed"), ing(2, "", "bay leaves"), ing(null, "", "crusty bread, to serve")],
    steps: ["Brown the beef in batches in a large pot; set aside.", "Soften the onion, carrot and celery for 6 minutes, then return the beef with the tomatoes, stock, barley and bay leaves.", "Simmer gently, partly covered, for 1½ hours.", "Add the potato and pumpkin and simmer for another 30 minutes until everything is tender and the barley has thickened the broth. Season and serve with bread."],
    notes: "Winter in a bowl — and even better reheated tomorrow." },

  // ----- MORE STIR-FRY -----
  { id: "starter-beef-noodles", title: "Beef Noodles (Pad See Ew Style)", category: "Stir-fry", time: "25 min", baseServings: 4,
    ingredients: [ing(440, "g", "fresh wide rice noodles"), ing(500, "g", "rump steak, thinly sliced"), ing(3, "", "garlic cloves, crushed"), ing(2, "", "eggs, lightly beaten"), ing(200, "g", "Chinese broccoli or broccolini, chopped"), ing(2, "tbsp", "dark soy sauce"), ing(2, "tbsp", "oyster sauce"), ing(1, "tbsp", "white vinegar"), ing(2, "tsp", "sugar"), ing(2, "tbsp", "vegetable oil")],
    steps: ["Mix the dark soy, oyster sauce, vinegar and sugar. Separate the noodles gently under warm water.", "Heat half the oil in a wok until smoking and sear the beef in batches; set aside.", "Add the remaining oil, the garlic for 20 seconds, then the greens for 1 minute. Push aside and scramble the eggs.", "Add the noodles and sauce and toss over the highest heat for 2 minutes, letting the noodles catch and char slightly at the edges. Return the beef and serve."],
    notes: "The slight char on the noodles is the whole point — maximum heat, minimum stirring." },
  { id: "starter-prawn-snowpea", title: "Garlic Prawn & Snow Pea Stir-fry", category: "Stir-fry", time: "15 min", baseServings: 4,
    ingredients: [ing(600, "g", "raw prawns, peeled"), ing(200, "g", "snow peas, trimmed"), ing(4, "", "garlic cloves, sliced"), ing(1, "tbsp", "grated ginger"), ing(2, "tbsp", "soy sauce"), ing(1, "tbsp", "shaoxing wine or mirin"), ing(1, "tsp", "sesame oil"), ing(1, "tsp", "cornflour mixed with 60 ml water"), ing(2, "tbsp", "vegetable oil"), ing(null, "", "steamed rice, to serve")],
    steps: ["Heat a wok until smoking, add half the oil, and flash-fry the prawns for 90 seconds until just pink. Set aside.", "Add the remaining oil, then the garlic and ginger for 20 seconds, and the snow peas for 1 minute.", "Return the prawns with the soy, shaoxing and sesame oil, then the cornflour slurry, tossing until glossy.", "Serve immediately over rice — total wok time is under five minutes."],
    notes: "Faster than the delivery app. Everything prepped before the wok goes on." },
  { id: "starter-teriyaki-chicken", title: "Teriyaki Chicken", category: "Stir-fry", time: "25 min", baseServings: 4,
    ingredients: [ing(700, "g", "chicken thigh fillets, sliced"), ing(80, "ml", "soy sauce"), ing(60, "ml", "mirin"), ing(2, "tbsp", "brown sugar"), ing(1, "tbsp", "grated ginger"), ing(2, "", "garlic cloves, crushed"), ing(1, "tbsp", "vegetable oil"), ing(null, "", "steamed rice, sesame seeds and sliced spring onion, to serve")],
    steps: ["Mix the soy, mirin, sugar, ginger and garlic.", "Brown the chicken in the oil over high heat in two batches until golden.", "Return all the chicken, pour in the sauce, and bubble for 3–4 minutes until it reduces to a sticky glaze that coats every piece.", "Serve over rice with sesame seeds and spring onion."],
    notes: "Four sauce ingredients you already own — no bottled teriyaki required." },

  // ----- CASSEROLES & ONE-POTS -----
  { id: "starter-beef-casserole", title: "Classic Beef Casserole", category: "Casserole", time: "2 hr 45 min", baseServings: 6,
    ingredients: [ing(1.2, "kg", "chuck steak, cut into large chunks"), ing(2, "tbsp", "plain flour, seasoned"), ing(2, "", "brown onions, cut into wedges"), ing(3, "", "carrots, thickly sliced"), ing(2, "", "celery stalks, sliced"), ing(3, "", "garlic cloves, crushed"), ing(2, "tbsp", "tomato paste"), ing(250, "ml", "red wine"), ing(500, "ml", "beef stock"), ing(2, "", "bay leaves"), ing(2, "tsp", "fresh thyme leaves"), ing(null, "", "mash and steamed greens, to serve")],
    steps: ["Preheat a fan-forced oven to 150°C. Toss the beef in the seasoned flour and brown in batches in an oiled cast-iron dutch oven. Set aside.", "Soften the onion, carrot and celery in the same pot for 6 minutes; add the garlic and tomato paste for 1 minute.", "Pour in the wine, scraping up the browned bits, then return the beef with the stock, bay and thyme.", "Cover and transfer to the oven for 2–2½ hours until the beef falls apart. Season and serve over mash."],
    notes: "Built for a dutch oven — the heavy lid does the work. Freezes perfectly." },
  { id: "starter-apricot-chicken", title: "Apricot Chicken", category: "Casserole", time: "1 hr", baseServings: 4,
    ingredients: [ing(8, "", "chicken thigh fillets or drumsticks"), ing(1, "", "brown onion, sliced"), ing(405, "ml", "tin apricot nectar"), ing(40, "g", "French onion soup mix (1 packet)"), ing(1, "tbsp", "Dijon mustard"), ing(150, "g", "green beans, trimmed"), ing(null, "", "steamed rice, to serve")],
    steps: ["Preheat a fan-forced oven to 180°C. Brown the chicken in an oiled ovenproof pot; set aside.", "Soften the onion for 4 minutes, then stir in the apricot nectar, soup mix and mustard.", "Return the chicken, cover, and bake for 40 minutes.", "Stir in the beans for the final 10 minutes, uncovered, until the sauce thickens. Serve with rice."],
    notes: "A 1970s Australian icon that never needed improving. Yes, the packet soup mix stays." },
  { id: "starter-devilled-sausages", title: "Devilled Sausages", category: "Casserole", time: "40 min", baseServings: 4,
    ingredients: [ing(8, "", "thick beef sausages"), ing(1, "", "brown onion, sliced"), ing(1, "", "apple, sliced"), ing(400, "g", "tin crushed tomatoes"), ing(2, "tbsp", "Worcestershire sauce"), ing(1, "tbsp", "brown sugar"), ing(2, "tsp", "Dijon mustard"), ing(1, "tsp", "smoked paprika"), ing(null, "", "mashed potato, to serve")],
    steps: ["Brown the sausages in a large pan; set aside and slice thickly if you like.", "Soften the onion and apple in the same pan for 5 minutes.", "Stir in the tomatoes, Worcestershire, sugar, mustard and paprika, and return the sausages.", "Simmer for 15–20 minutes until the sauce is glossy. Serve over mash."],
    notes: "The apple is the old-school touch — it melts into the sauce." },
  { id: "starter-cacciatore", title: "Chicken Cacciatore", category: "Casserole", time: "1 hr 15 min", baseServings: 6,
    ingredients: [ing(1.2, "kg", "chicken thighs and drumsticks, bone in"), ing(1, "", "brown onion, sliced"), ing(1, "", "red capsicum, sliced"), ing(4, "", "garlic cloves, sliced"), ing(400, "g", "tin crushed tomatoes"), ing(125, "ml", "dry white wine"), ing(80, "g", "kalamata olives"), ing(2, "", "anchovy fillets (optional, trust the process)"), ing(2, "tsp", "dried oregano"), ing(null, "", "crusty bread or polenta, to serve")],
    steps: ["Brown the chicken well, skin-side first, in an oiled heavy pot. Set aside.", "Soften the onion and capsicum for 5 minutes; add the garlic, anchovies and oregano for 1 minute.", "Add the wine and bubble it down, then the tomatoes. Return the chicken, skin up.", "Simmer, partly covered, for 40 minutes. Scatter in the olives for the last 10. Serve with bread for the sauce."],
    notes: "The anchovies dissolve entirely — nobody will know, everybody will notice." },
  { id: "starter-chilli-con-carne", title: "Chilli Con Carne", category: "Casserole", time: "1 hr 15 min", baseServings: 6,
    ingredients: [ing(750, "g", "beef mince"), ing(1, "", "brown onion, diced"), ing(1, "", "red capsicum, diced"), ing(3, "", "garlic cloves, crushed"), ing(2, "tbsp", "smoked paprika"), ing(1, "tbsp", "ground cumin"), ing(1, "tsp", "chilli powder (more if you're brave)"), ing(2, "tbsp", "tomato paste"), ing(800, "g", "tinned crushed tomatoes (two tins)"), ing(400, "g", "tin red kidney beans, drained"), ing(250, "ml", "beef stock"), ing(20, "g", "dark chocolate"), ing(null, "", "rice, sour cream, cheese and corn chips, to serve")],
    steps: ["Brown the mince hard in a large pot; add the onion and capsicum for 5 minutes, then the garlic and spices for 1 minute.", "Stir in the tomato paste, tomatoes and stock and simmer, uncovered, for 45 minutes.", "Add the beans and chocolate for the final 10 minutes.", "Season and serve over rice with the full array of toppings."],
    notes: "The chocolate rounds out the chilli — an old trick that works every time. Better on day two." },
  { id: "starter-lamb-shanks", title: "Slow-Braised Lamb Shanks", category: "Casserole", time: "3 hr", baseServings: 4,
    ingredients: [ing(4, "", "lamb shanks"), ing(1, "", "brown onion, diced"), ing(2, "", "carrots, chopped"), ing(4, "", "garlic cloves, crushed"), ing(2, "tbsp", "tomato paste"), ing(375, "ml", "red wine"), ing(500, "ml", "beef stock"), ing(2, "", "sprigs rosemary"), ing(2, "", "bay leaves"), ing(null, "", "creamy mash, to serve")],
    steps: ["Preheat a fan-forced oven to 150°C. Brown the shanks all over in an oiled dutch oven; set aside.", "Soften the onion and carrot for 5 minutes; add the garlic and tomato paste for 1 minute.", "Add the wine and reduce by half, then return the shanks with the stock, rosemary and bay — the liquid should come halfway up.", "Cover and braise in the oven for 2½–3 hours, turning once, until the meat is sliding off the bone. Skim, reduce the sauce on the stove if needed, and serve over mash."],
    notes: "Impossible to overcook within reason — the shank forgives everything except impatience." },
  { id: "starter-stroganoff", title: "Beef Stroganoff", category: "Casserole", time: "35 min", baseServings: 4,
    ingredients: [ing(600, "g", "rump or scotch fillet, thinly sliced"), ing(300, "g", "mushrooms, sliced"), ing(1, "", "brown onion, sliced"), ing(2, "", "garlic cloves, crushed"), ing(1, "tbsp", "sweet paprika"), ing(1, "tbsp", "Dijon mustard"), ing(1, "tbsp", "tomato paste"), ing(250, "ml", "beef stock"), ing(200, "g", "sour cream"), ing(40, "g", "butter"), ing(null, "", "pasta, rice or mash, to serve")],
    steps: ["Sear the beef in batches in a very hot, oiled pan — 30 seconds a side. Set aside.", "Add the butter and cook the mushrooms until golden, then the onion for 4 minutes and the garlic and paprika for 1 minute.", "Stir in the mustard, tomato paste and stock and simmer for 5 minutes.", "Off the heat, stir through the sour cream and return the beef just to warm through — don't boil it. Season and serve."],
    notes: "The beef finishes in the residual heat; boiling after the sour cream goes in splits the sauce and toughens the meat." },
  { id: "starter-pork-meatballs", title: "Pork & Fennel Meatballs in Sugo", category: "Casserole", time: "50 min", baseServings: 4,
    ingredients: [ing(600, "g", "pork mince"), ing(60, "g", "breadcrumbs"), ing(1, "", "egg"), ing(50, "g", "parmesan, grated, plus extra"), ing(2, "tsp", "fennel seeds, lightly crushed"), ing(3, "", "garlic cloves, crushed"), ing(700, "g", "tomato passata"), ing(0.5, "tsp", "chilli flakes"), ing(null, "", "crusty bread or pasta, to serve")],
    steps: ["Mix the mince, breadcrumbs, egg, parmesan, fennel and a third of the garlic; season well and roll into 16 balls.", "Brown the meatballs in an oiled pan; set aside (they finish cooking in the sauce).", "Cook the remaining garlic and chilli for 30 seconds, add the passata and a splash of water, and simmer for 5 minutes.", "Return the meatballs and simmer gently, covered, for 15 minutes. Serve with extra parmesan and bread."],
    notes: "Pork and fennel is the sausage-shop combination in meatball form." },

  // ----- MORE WEEKNIGHT -----
  { id: "starter-zucchini-slice", title: "Zucchini Slice", category: "Weeknight", time: "50 min", baseServings: 6,
    ingredients: [ing(400, "g", "zucchini, grated (about 2 large)"), ing(1, "", "brown onion, finely diced"), ing(200, "g", "bacon, diced"), ing(5, "", "eggs"), ing(150, "g", "self-raising flour"), ing(125, "ml", "vegetable oil"), ing(150, "g", "grated tasty cheese")],
    steps: ["Preheat a fan-forced oven to 170°C and line a 28 × 18 cm slice tin.", "Squeeze the excess moisture from the grated zucchini.", "Whisk the eggs and oil, then stir in the flour, zucchini, onion, bacon and cheese. Season well.", "Pour into the tin and bake for 30–35 minutes until golden and set. Great hot, warm or cold in tomorrow's lunchbox."],
    notes: "The Women's Weekly classic — dinner tonight, lunch tomorrow." },
  { id: "starter-burgers", title: "Homemade Beef Burgers", category: "Weeknight", time: "30 min", baseServings: 4,
    ingredients: [ing(600, "g", "beef mince"), ing(1, "tsp", "salt"), ing(4, "", "burger buns, split"), ing(4, "", "slices tasty cheese"), ing(1, "", "tomato, sliced"), ing(null, "", "lettuce, sliced beetroot, caramelised onion, and sauce of choice"), ing(1, "tbsp", "butter, for the buns")],
    steps: ["Divide the mince into 4 and shape into loose balls — don't compress or knead, and season the outsides only.", "Heat a heavy pan or BBQ plate until very hot. Smash each ball flat with a spatula and cook for 2–3 minutes until deeply crusted.", "Flip, top with cheese, and cook 2 minutes more.", "Butter and toast the buns cut-side down, then build: sauce, lettuce, patty, beetroot, tomato, onion. The beetroot is not negotiable in this country."],
    notes: "Loose mince + hard sear = juicy burger. Overworked mince = rubber." },
  { id: "starter-san-choy-bau", title: "San Choy Bau", category: "Weeknight", time: "20 min", baseServings: 4,
    ingredients: [ing(500, "g", "pork mince"), ing(1, "tbsp", "grated ginger"), ing(3, "", "garlic cloves, crushed"), ing(227, "g", "tin water chestnuts, drained and chopped"), ing(3, "", "spring onions, sliced"), ing(2, "tbsp", "oyster sauce"), ing(1, "tbsp", "soy sauce"), ing(1, "tsp", "sesame oil"), ing(1, "", "iceberg lettuce, leaves separated into cups"), ing(null, "", "crushed peanuts and extra spring onion, to serve")],
    steps: ["Brown the pork mince hard in an oiled wok, breaking it up well.", "Add the ginger and garlic for 1 minute, then the water chestnuts, oyster sauce, soy and sesame oil for 2 minutes.", "Fold through the spring onions.", "Spoon into cold, crisp lettuce cups at the table and top with peanuts. Eat with your hands, lose some down your sleeve — tradition."],
    notes: "The contrast is everything: hot savoury pork, ice-cold lettuce, crunchy chestnuts." },
  { id: "starter-tuna-patties", title: "Tuna Patties", category: "Weeknight", time: "35 min", baseServings: 4,
    ingredients: [ing(600, "g", "potatoes, peeled and chopped"), ing(425, "g", "tin tuna, drained"), ing(3, "", "spring onions, sliced"), ing(1, "", "egg"), ing(1, "", "lemon, zested and cut into wedges"), ing(80, "g", "panko breadcrumbs (half in, half for coating)"), ing(null, "", "salad and tartare or sweet chilli, to serve")],
    steps: ["Boil the potatoes until tender, drain well, and mash roughly. Cool slightly.", "Mix in the tuna, spring onion, egg, lemon zest and half the breadcrumbs; season. Shape into 8 patties.", "Coat in the remaining crumbs and chill for 10 minutes if you have time.", "Shallow-fry in hot oil for 3–4 minutes each side until golden. Serve with lemon wedges and salad."],
    notes: "Pantry-and-fridge dinner — also excellent cold the next day." },
  { id: "starter-nachos", title: "Loaded Beef Nachos", category: "Weeknight", time: "30 min", baseServings: 4,
    ingredients: [ing(500, "g", "beef mince"), ing(1, "", "brown onion, diced"), ing(2, "", "garlic cloves, crushed"), ing(1, "tbsp", "smoked paprika"), ing(2, "tsp", "ground cumin"), ing(400, "g", "tin crushed tomatoes"), ing(400, "g", "tin red kidney beans, drained"), ing(200, "g", "corn chips"), ing(200, "g", "grated tasty cheese"), ing(null, "", "sour cream, guacamole and jalapeños, to serve")],
    steps: ["Preheat a fan-forced oven to 200°C. Brown the mince, add the onion for 4 minutes, then the garlic and spices for 1 minute.", "Add the tomatoes and beans and simmer for 10 minutes until thick.", "Layer corn chips, beef and cheese in a large ovenproof dish — two layers so the middle chips get saucy.", "Bake for 8–10 minutes until molten, and finish with sour cream, guac and jalapeños straight down the middle."],
    notes: "Friday night, tray in the middle of the table, everyone fends for themselves." },

  // ----- SALADS -----
  { id: "starter-caesar", title: "Chicken Caesar Salad", category: "Salad", time: "30 min", baseServings: 4,
    ingredients: [ing(500, "g", "chicken breast"), ing(2, "", "cos lettuces, chopped"), ing(150, "g", "bacon, diced"), ing(4, "", "eggs"), ing(0.5, "", "baguette, torn into croutons"), ing(60, "g", "parmesan, shaved"), ing(120, "g", "whole-egg mayonnaise"), ing(2, "", "anchovy fillets, mashed"), ing(1, "", "garlic clove, crushed"), ing(1, "tbsp", "lemon juice"), ing(1, "tsp", "Dijon mustard")],
    steps: ["Toss the croutons in olive oil and bake at 190°C fan-forced for 8–10 minutes until golden. Crisp the bacon in a pan.", "Poach or pan-fry the chicken until just cooked; rest and slice. Boil the eggs for 6½ minutes, cool and halve.", "Whisk the mayonnaise, anchovies, garlic, lemon juice, Dijon and a splash of water into a pourable dressing.", "Toss the cos with most of the dressing, then top with chicken, bacon, croutons, eggs and parmesan, and drizzle the rest over."],
    notes: "The anchovies in the dressing are the difference between Caesar and 'chicken salad'." },
  { id: "starter-thai-beef-salad", title: "Thai Beef Salad", category: "Salad", time: "25 min", baseServings: 4,
    ingredients: [ing(600, "g", "rump or sirloin steak"), ing(250, "g", "cherry tomatoes, halved"), ing(1, "", "continental cucumber, sliced"), ing(1, "", "red onion, thinly sliced"), ing(1, "", "large handful each mint and coriander"), ing(60, "g", "roasted peanuts, crushed"), ing(3, "tbsp", "lime juice"), ing(2, "tbsp", "fish sauce"), ing(1, "tbsp", "brown sugar"), ing(1, "", "red chilli, finely sliced")],
    steps: ["Whisk the lime juice, fish sauce, sugar and chilli — it should taste hot, sour, salty and sweet in that order.", "Cook the steak on a screaming hot pan or BBQ for 3–4 minutes a side for medium-rare. Rest 10 minutes and slice thinly.", "Toss the tomatoes, cucumber, onion and herbs with half the dressing.", "Top with the beef and its resting juices, spoon over the rest of the dressing, and finish with peanuts."],
    notes: "Rest the beef properly — the juices become part of the dressing." },

  // ----- MORE ROASTS -----
  { id: "starter-lamb-shoulder", title: "Slow-Roasted Lamb Shoulder", category: "Roast", time: "4 hr 30 min", baseServings: 6,
    ingredients: [ing(1.8, "kg", "lamb shoulder, bone in"), ing(1, "", "garlic bulb, halved crossways, plus 4 cloves slivered"), ing(2, "", "sprigs rosemary, leaves picked"), ing(2, "tbsp", "olive oil"), ing(250, "ml", "white wine or stock"), ing(1, "kg", "potatoes, halved"), ing(1, "", "lemon, juiced")],
    steps: ["Preheat a fan-forced oven to 150°C. Pierce the lamb all over and push in the garlic slivers and rosemary. Rub with oil and season hard.", "Sit the lamb on the halved garlic bulb in a deep roasting pan, pour the wine around, cover tightly with foil, and roast for 3½ hours.", "Uncover, add the potatoes to the pan juices, turn the oven to 200°C, and roast for another 45–60 minutes until the lamb is mahogany and pulls apart with tongs.", "Rest 20 minutes, squeeze lemon over, and serve by pulling — no carving knife required."],
    notes: "The Sunday roast that cooks itself. Leftovers make superb wraps." },
  { id: "starter-pork-crackling", title: "Roast Pork with Crackling", category: "Roast", time: "2 hr", baseServings: 6,
    ingredients: [ing(1.8, "kg", "boneless pork shoulder or loin, skin on and scored"), ing(2, "tbsp", "olive oil"), ing(1, "tbsp", "sea salt flakes"), ing(2, "tsp", "fennel seeds"), ing(800, "g", "potatoes and pumpkin, chopped"), ing(2, "", "apples, quartered"), ing(null, "", "gravy and steamed greens, to serve")],
    steps: ["Dry the pork skin overnight in the fridge, uncovered, if you can — dry skin is the whole game.", "Preheat a fan-forced oven to 230°C. Rub the skin with oil, then work the salt and fennel seeds into the score lines.", "Roast at 230°C for 30 minutes until the skin blisters and crackles, then reduce to 170°C for 1–1¼ hours more (add the vegetables and apples for the final hour).", "Rest 15 minutes — under no circumstances cover the crackling with foil — then carve with a serrated knife."],
    notes: "Fridge-dried skin, ferocious initial heat, and never foil the crackling. That's the whole secret." },
];

/* ---------- The Bakehouse collection (pan- and batch-scaled) ---------- */

const BAKE_TIMING = {"Classic Vanilla Butter Cake":[25,35,60,20],"Chocolate Mud Cake":[25,60,120,20],"Carrot Cake with Walnuts":[30,40,60,25],"Lemon Butter Cake":[25,35,60,15],"Chocolate Caramel Slice":[25,27,150,15],"Lemon Slice (No-Bake)":[25,0,150,15],"Raspberry Coconut Slice":[25,40,60,10],"Anzac Biscuits":[20,15,15,0],"Chocolate Chip Cookies":[20,14,15,0],"Traditional Shortbread":[20,28,20,5],"Banana Bread":[15,55,30,0],"Fudgy Chocolate Brownies":[20,33,90,0],"Red Velvet Cake":[30,35,60,30],"Banana Cake":[20,35,45,15],"Coffee Walnut Cake":[25,35,60,25],"Orange Almond Cake (Flourless)":[25,105,60,5],"Coconut Cake":[25,35,60,20],"Marble Cake":[30,35,60,15],"Spiced Apple Cake":[30,40,45,5],"Sticky Date Cake with Butterscotch Sauce":[30,40,30,15],"Passionfruit Cake":[25,35,60,15],"Pistachio Cake":[30,35,60,15],"Hummingbird Cake":[25,40,60,25],"Lime Coconut Cake":[25,35,60,15],"Earl Grey Cake":[30,35,60,20],"Ginger Cake":[20,40,60,10],"Victoria Sponge":[25,28,60,20],"Chocolate Beetroot Cake":[25,40,60,20],"Chocolate Weet-Bix Slice":[20,17,30,15],"Vanilla Slice":[45,15,240,15],"Jelly Slice":[30,0,300,0],"Peppermint Slice":[30,15,150,10],"Muesli Slice":[15,23,45,0],"Coconut Jam Slice":[20,40,45,0],"Nutella Slice":[15,24,45,0],"Passionfruit Slice":[20,27,120,0],"Apricot Slice (No-Bake)":[20,0,120,0],"Date Slice":[30,28,45,0],"Rocky Road Slice":[20,0,90,0],"Ginger Slice":[20,19,45,10],"Marshmallow Slice":[30,18,150,10],"Millionaire's Shortbread":[25,20,150,10],"Cherry Ripe Slice":[25,0,150,10],"Honey Joy Slice":[10,10,30,0],"Apple Crumble Slice":[35,35,30,0],"Melting Moments":[30,15,30,15],"Gingerbread Biscuits":[55,11,20,20],"Jam Drops":[25,15,20,0],"Monte Carlos":[30,12,30,20],"Yo-Yos":[30,15,30,15],"Chocolate Macarons":[75,17,30,30],"Meringue Kisses":[20,90,60,0],"Oat & Sultana Cookies":[20,13,15,0],"Double Choc Cookies":[20,12,15,0],"Lemon Meringue Tart":[80,40,60,10],"Portuguese Egg Tarts":[25,23,15,0],"Fresh Fruit Tart":[60,30,120,20],"Chocolate Ganache Tart":[70,28,120,5],"Pear Frangipane Tart":[75,38,30,10],"Rough Puff Pastry (for Sausage Rolls & Pies)":[30,0,60,0],"Profiteroles (Choux Pastry)":[35,28,30,25],"Apple Pie":[80,48,20,0],"Blueberry Muffins":[15,21,15,0],"Choc Chip Muffins":[15,20,15,0],"Scones":[15,14,10,0],"Date Loaf":[20,50,30,0],"Zucchini Walnut Loaf":[20,55,30,0],"White Choc Macadamia Blondies":[20,30,60,0],"Pavlova":[25,90,120,15],"Baked Cheesecake":[30,60,300,0],"Cinnamon Tea Cake":[15,25,15,5],"Raspberry Friands":[15,20,15,5],"White Sandwich Loaf":[25,33,140,0],"Wholemeal (Brown) Loaf":[25,35,140,0],"Seeded Multigrain Loaf":[25,35,140,0],"Olive Loaf":[30,35,150,0],"Rosemary & Thyme Focaccia":[25,24,120,0],"Spinach & Feta Swirl Loaf":[40,35,140,0],"Bacon & Cheese Loaf":[35,35,140,0],"Classic Sourdough Loaf":[40,45,840,0],"Cinnamon Raisin Loaf":[30,35,150,10],"Cheese & Herb Damper":[15,30,20,0],"Garlic Pull-Apart Bread":[35,30,130,0],"Turkish-Style Pide Bread":[25,15,110,0]};
const totalMinutesFor = (r) => {
  const t = BAKE_TIMING[r.title];
  if (!t) return null;
  const tot = (t[0] || 0) + (t[1] || 0) + (t[2] || 0) + (t[3] || 0);
  return tot > 0 ? tot : null;
};
const fmtDur = (m) => {
  m = Math.round(m);
  const h = Math.floor(m / 60), mm = m % 60;
  return h ? `${h} h${mm ? ` ${mm} min` : ""}` : `${mm} min`;
};

const BAKE_RECIPES = [{"id":"bake-vanilla-butter","title":"Classic Vanilla Butter Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"unsalted butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":2,"unit":"tsp","name":"vanilla extract"},{"amount":4,"unit":"","name":"eggs (room temperature)"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":125,"unit":"ml","name":"milk"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter, sugar and vanilla with a stand mixer until pale and fluffy, 4–5 minutes.","Add eggs one at a time, beating well after each.","Fold in flour and milk in alternating batches, starting and ending with flour.","Divide between pans, smooth the tops and bake 30–35 minutes until a skewer comes out clean.","Cool in pans 10 minutes, then turn onto a wire rack."],"notes":""},{"id":"bake-choc-mud","title":"Chocolate Mud Cake","category":"Cakes","time":"50–60 min","temp":"150°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"unsalted butter"},{"amount":200,"unit":"g","name":"dark chocolate, chopped"},{"amount":330,"unit":"g","name":"caster sugar"},{"amount":250,"unit":"ml","name":"milk"},{"amount":225,"unit":"g","name":"plain flour"},{"amount":75,"unit":"g","name":"self-raising flour"},{"amount":40,"unit":"g","name":"cocoa powder"},{"amount":2,"unit":"","name":"eggs lightly beaten"},{"amount":2,"unit":"tsp","name":"vanilla extract"}],"steps":["Preheat oven to 150°C fan-forced. Grease and line the pans.","Melt butter, chocolate, sugar and milk in a saucepan over low heat, stirring until smooth. Cool 15 minutes.","Sift flours and cocoa into a large bowl. Whisk in the chocolate mixture.","Whisk in eggs and vanilla until combined.","Divide between pans and bake 50–60 minutes until a skewer comes out with moist crumbs.","Cool completely in the pans — mud cake is fragile while warm."],"notes":""},{"id":"bake-carrot","title":"Carrot Cake with Walnuts","category":"Cakes","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":300,"unit":"g","name":"carrot, coarsely grated"},{"amount":250,"unit":"ml","name":"vegetable oil"},{"amount":220,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":2,"unit":"tsp","name":"ground cinnamon"},{"amount":1,"unit":"tsp","name":"ground ginger"},{"amount":100,"unit":"g","name":"walnuts, chopped"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Whisk oil, sugar and eggs until combined.","Fold in flour and spices, then carrot and walnuts.","Divide between pans and bake 35–40 minutes until a skewer comes out clean.","Cool in pans 10 minutes, then turn onto a wire rack. Ice with cream cheese frosting once cold."],"notes":""},{"id":"bake-lemon-butter-cake","title":"Lemon Butter Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"unsalted butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":2,"unit":"tbsp","name":"lemon zest (about 2 lemons)"},{"amount":3,"unit":"","name":"eggs"},{"amount":260,"unit":"g","name":"self-raising flour"},{"amount":100,"unit":"ml","name":"milk"},{"amount":60,"unit":"ml","name":"lemon juice"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter, sugar and zest until pale and fluffy.","Add eggs one at a time, beating well after each.","Fold in flour alternately with combined milk and lemon juice.","Divide between pans and bake 30–35 minutes until golden and a skewer comes out clean.","Cool 10 minutes in pans, then turn out. Finish with lemon glaze if desired."],"notes":""},{"id":"bake-caramel-slice","title":"Chocolate Caramel Slice","category":"Slices","time":"Base 15 min + caramel 12 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":150,"unit":"g","name":"plain flour"},{"amount":90,"unit":"g","name":"brown sugar"},{"amount":60,"unit":"g","name":"desiccated coconut"},{"amount":125,"unit":"g","name":"butter, melted (base)"},{"amount":395,"unit":"g","name":"sweetened condensed milk (1 tin)"},{"amount":60,"unit":"g","name":"butter, extra (caramel)"},{"amount":40,"unit":"g","name":"golden syrup"},{"amount":200,"unit":"g","name":"dark chocolate (topping)"},{"amount":20,"unit":"g","name":"copha or 1 tbsp vegetable oil"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 20 × 30 cm slice tin.","Mix flour, brown sugar, coconut and melted butter; press firmly into the tin. Bake 15 minutes until light golden.","Stir condensed milk, extra butter and golden syrup in a saucepan over low heat 8–10 minutes until thick and golden. Pour over base and bake 12 minutes. Cool completely.","Melt chocolate with copha, spread over the caramel and refrigerate until set.","Cut with a hot knife into squares."],"notes":""},{"id":"bake-lemon-slice","title":"Lemon Slice (No-Bake)","category":"Slices","time":"Set 2+ hours","temp":"No bake — refrigerate","scaling":"pan","basePan":{"shape":"rectangle","length":28,"width":18,"quantity":1},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"Marie biscuits, crushed"},{"amount":95,"unit":"g","name":"desiccated coconut"},{"amount":395,"unit":"g","name":"sweetened condensed milk (1 tin)"},{"amount":125,"unit":"g","name":"butter, melted"},{"amount":2,"unit":"tbsp","name":"lemon zest"},{"amount":240,"unit":"g","name":"icing sugar (icing)"},{"amount":40,"unit":"ml","name":"lemon juice (icing)"},{"amount":20,"unit":"g","name":"butter, softened (icing)"}],"steps":["Line the slice tin with baking paper.","Combine biscuit crumbs, coconut and zest. Stir in condensed milk and melted butter.","Press firmly into the tin and refrigerate 30 minutes.","Beat icing sugar, lemon juice and butter until smooth; spread over the base.","Refrigerate 2 hours until firm, then slice."],"notes":""},{"id":"bake-raspberry-coconut-slice","title":"Raspberry Coconut Slice","category":"Slices","time":"Base 15 min + top 25 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":150,"unit":"g","name":"plain flour"},{"amount":55,"unit":"g","name":"caster sugar (base)"},{"amount":125,"unit":"g","name":"butter, chilled and cubed"},{"amount":200,"unit":"g","name":"raspberry jam"},{"amount":2,"unit":"","name":"eggs lightly beaten (topping)"},{"amount":55,"unit":"g","name":"caster sugar (topping)"},{"amount":180,"unit":"g","name":"desiccated coconut"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 20 × 30 cm slice tin.","Blitz flour, sugar and butter to fine crumbs; press into the tin. Bake 15 minutes.","Spread jam over the warm base.","Mix eggs, sugar and coconut; scatter evenly over the jam.","Bake 25 minutes until golden. Cool in the tin before slicing."],"notes":""},{"id":"bake-anzac","title":"Anzac Biscuits","category":"Biscuits & Cookies","time":"12–15 min","temp":"150°C fan-forced","scaling":"batch","yield":"Makes about 24","baseServings":1,"ingredients":[{"amount":150,"unit":"g","name":"plain flour"},{"amount":90,"unit":"g","name":"rolled oats"},{"amount":85,"unit":"g","name":"desiccated coconut"},{"amount":155,"unit":"g","name":"brown sugar"},{"amount":125,"unit":"g","name":"butter"},{"amount":60,"unit":"g","name":"golden syrup"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"},{"amount":2,"unit":"tbsp","name":"boiling water"}],"steps":["Preheat oven to 150°C fan-forced. Line two trays with baking paper.","Combine flour, oats, coconut and sugar in a bowl.","Melt butter and golden syrup. Mix bicarb with boiling water, add to butter — it will foam — then stir into the dry mix.","Roll tablespoons of mixture, place 5 cm apart and flatten slightly.","Bake 12–15 minutes until deep golden. Cool on trays — they crisp as they cool."],"notes":""},{"id":"bake-choc-chip","title":"Chocolate Chip Cookies","category":"Biscuits & Cookies","time":"12–14 min","temp":"160°C fan-forced","scaling":"batch","yield":"Makes about 20","baseServings":1,"ingredients":[{"amount":125,"unit":"g","name":"butter, softened"},{"amount":100,"unit":"g","name":"brown sugar"},{"amount":55,"unit":"g","name":"caster sugar"},{"amount":1,"unit":"","name":"eggs"},{"amount":1,"unit":"tsp","name":"vanilla extract"},{"amount":190,"unit":"g","name":"plain flour"},{"amount":0.5,"unit":"tsp","name":"bicarbonate of soda"},{"amount":200,"unit":"g","name":"dark choc chips"}],"steps":["Preheat oven to 160°C fan-forced. Line two trays.","Cream butter and both sugars until pale. Beat in egg and vanilla.","Fold in flour and bicarb, then choc chips.","Roll tablespoons of dough, space 5 cm apart.","Bake 12–14 minutes until golden at the edges but soft in the centre. Cool on trays."],"notes":""},{"id":"bake-shortbread","title":"Traditional Shortbread","category":"Biscuits & Cookies","time":"25–30 min","temp":"140°C fan-forced","scaling":"batch","yield":"Makes about 24","baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"butter, softened"},{"amount":80,"unit":"g","name":"icing sugar"},{"amount":250,"unit":"g","name":"plain flour"},{"amount":60,"unit":"g","name":"rice flour"}],"steps":["Preheat oven to 140°C fan-forced. Line two trays.","Beat butter and icing sugar until very pale and creamy.","Fold in both flours to form a soft dough.","Roll out to 1 cm thick, cut into fingers or rounds, prick with a fork.","Bake 25–30 minutes until pale golden. Dust with caster sugar while warm."],"notes":""},{"id":"bake-banana-bread","title":"Banana Bread","category":"Loaves, Muffins & Other","time":"50–55 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":21,"width":11,"quantity":1},"baseServings":1,"ingredients":[{"amount":350,"unit":"g","name":"very ripe banana, mashed (about 3)"},{"amount":125,"unit":"g","name":"butter, melted"},{"amount":150,"unit":"g","name":"brown sugar"},{"amount":2,"unit":"","name":"eggs"},{"amount":260,"unit":"g","name":"self-raising flour"},{"amount":1,"unit":"tsp","name":"ground cinnamon"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 21 × 11 cm loaf tin.","Whisk banana, melted butter, sugar and eggs together.","Fold in flour and cinnamon until just combined — don't overmix.","Pour into the tin and bake 50–55 minutes until a skewer comes out clean.","Cool in the tin 10 minutes, then turn out."],"notes":""},{"id":"bake-brownies","title":"Fudgy Chocolate Brownies","category":"Loaves, Muffins & Other","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"square","side":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"dark chocolate, chopped"},{"amount":175,"unit":"g","name":"butter"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":90,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":120,"unit":"g","name":"plain flour"},{"amount":30,"unit":"g","name":"cocoa powder"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 20 cm square tin.","Melt chocolate and butter together; cool slightly.","Whisk in both sugars, then eggs one at a time.","Fold in flour and cocoa until just combined.","Bake 30–35 minutes until the top is set but the centre is still fudgy. Cool completely before cutting."],"notes":""},{"id":"bake-red-velvet","title":"Red Velvet Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":300,"unit":"g","name":"plain flour"},{"amount":30,"unit":"g","name":"cocoa powder"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":250,"unit":"ml","name":"buttermilk"},{"amount":250,"unit":"ml","name":"vegetable oil"},{"amount":2,"unit":"","name":"eggs"},{"amount":2,"unit":"tsp","name":"red food colouring"},{"amount":1,"unit":"tsp","name":"white vinegar"},{"amount":1,"unit":"tsp","name":"vanilla extract"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Sift flour, cocoa and bicarb; stir in sugar.","Whisk buttermilk, oil, eggs, colouring, vinegar and vanilla; fold into the dry mix until smooth.","Divide between pans and bake 30–35 minutes until a skewer comes out clean.","Cool completely; sandwich and top with cream cheese frosting."],"notes":""},{"id":"bake-banana-cake","title":"Banana Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":125,"unit":"g","name":"butter, softened"},{"amount":200,"unit":"g","name":"caster sugar"},{"amount":2,"unit":"","name":"eggs"},{"amount":350,"unit":"g","name":"very ripe banana, mashed"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"},{"amount":60,"unit":"ml","name":"warm milk"},{"amount":300,"unit":"g","name":"self-raising flour"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar; beat in eggs one at a time, then banana.","Dissolve bicarb in the warm milk and stir through.","Fold in flour until just combined.","Bake 30–35 minutes. Cool, then ice with lemon or cream cheese icing."],"notes":""},{"id":"bake-coffee-walnut","title":"Coffee Walnut Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"butter, softened"},{"amount":220,"unit":"g","name":"brown sugar"},{"amount":4,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":2,"unit":"tbsp","name":"instant coffee dissolved in 60 ml hot water, cooled"},{"amount":100,"unit":"g","name":"walnuts, chopped"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar until fluffy; add eggs one at a time.","Fold in flour, then the coffee and walnuts.","Bake 30–35 minutes until a skewer comes out clean.","Cool and fill with coffee buttercream; top with walnut halves."],"notes":""},{"id":"bake-orange-almond","title":"Flourless Orange Almond Cake","category":"Cakes","time":"45–50 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":22,"quantity":1},"baseServings":1,"ingredients":[{"amount":400,"unit":"g","name":"whole oranges (about 2), boiled 1 hr, then puréed"},{"amount":6,"unit":"","name":"eggs"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":300,"unit":"g","name":"almond meal"},{"amount":1,"unit":"tsp","name":"baking powder"}],"steps":["Boil whole oranges in water for 1 hour; cool, remove seeds, purée skin and all.","Preheat oven to 160°C fan-forced. Grease and line a 22 cm round pan.","Whisk eggs and sugar until pale; fold in orange purée, almond meal and baking powder.","Bake 45–50 minutes until firm in the centre.","Cool in the pan. Gluten-free — great with syrup or dusted with icing sugar."],"notes":""},{"id":"bake-coconut-cake","title":"Coconut Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":85,"unit":"g","name":"desiccated coconut"},{"amount":250,"unit":"ml","name":"coconut milk"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar; add eggs one at a time.","Fold in flour and coconut alternately with coconut milk.","Bake 30–35 minutes until a skewer comes out clean.","Cool; ice with coconut buttercream and toasted coconut flakes."],"notes":""},{"id":"bake-marble","title":"Marble Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":2,"unit":"tsp","name":"vanilla extract"},{"amount":4,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":125,"unit":"ml","name":"milk"},{"amount":25,"unit":"g","name":"cocoa powder mixed with 2 tbsp milk"},{"amount":0.5,"unit":"tsp","name":"pink food colouring"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Make a vanilla butter cake batter (cream butter, sugar, vanilla; add eggs; fold flour and milk).","Divide batter in three: leave one plain, colour one pink, stir cocoa paste into the third.","Dollop alternating spoonfuls into the pans and swirl once with a skewer.","Bake 30–35 minutes. Cool and ice with chocolate glacé icing."],"notes":""},{"id":"bake-spiced-apple","title":"Spiced Apple Cake","category":"Cakes","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"butter, softened"},{"amount":200,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":2,"unit":"tsp","name":"ground cinnamon"},{"amount":0.5,"unit":"tsp","name":"ground nutmeg"},{"amount":300,"unit":"g","name":"apple, peeled and diced (about 2)"},{"amount":60,"unit":"ml","name":"milk"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar; add eggs one at a time.","Fold in flour, spices and milk, then the diced apple.","Bake 35–40 minutes until a skewer comes out clean.","Dust with cinnamon sugar while warm."],"notes":""},{"id":"bake-sticky-date","title":"Sticky Date Cake","category":"Cakes","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":350,"unit":"g","name":"pitted dates, chopped"},{"amount":375,"unit":"ml","name":"water"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"},{"amount":125,"unit":"g","name":"butter, softened"},{"amount":220,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"}],"steps":["Simmer dates and water 5 minutes; stir in bicarb (it foams) and cool 15 minutes.","Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar; add eggs one at a time.","Fold in flour and the date mixture.","Bake 35–40 minutes. Serve warm with butterscotch sauce: 100 g butter, 200 g brown sugar, 300 ml cream simmered 5 minutes."],"notes":""},{"id":"bake-passionfruit-cake","title":"Passionfruit Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":4,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":80,"unit":"ml","name":"milk"},{"amount":120,"unit":"g","name":"passionfruit pulp (about 4)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar; add eggs one at a time.","Fold in flour alternately with milk, then the pulp.","Bake 30–35 minutes until a skewer comes out clean.","Ice with passionfruit glacé icing (icing sugar + extra pulp)."],"notes":""},{"id":"bake-pistachio","title":"Pistachio Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":4,"unit":"","name":"eggs"},{"amount":200,"unit":"g","name":"self-raising flour"},{"amount":150,"unit":"g","name":"pistachios, finely ground"},{"amount":100,"unit":"ml","name":"milk"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar; add eggs one at a time.","Fold in flour and ground pistachios alternately with milk.","Bake 30–35 minutes until a skewer comes out clean.","Finish with white chocolate ganache and chopped pistachios."],"notes":""},{"id":"bake-hummingbird","title":"Hummingbird Cake","category":"Cakes","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":300,"unit":"g","name":"plain flour"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"},{"amount":2,"unit":"tsp","name":"ground cinnamon"},{"amount":250,"unit":"ml","name":"vegetable oil"},{"amount":220,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"mashed banana"},{"amount":225,"unit":"g","name":"crushed pineapple, well drained"},{"amount":50,"unit":"g","name":"pecans, chopped"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Sift flour, bicarb and cinnamon into a large bowl.","Whisk oil, sugar and eggs; stir into the dry mix with banana, pineapple and pecans.","Bake 35–40 minutes until a skewer comes out clean.","Cool and frost with cream cheese icing."],"notes":""},{"id":"bake-lime-coconut","title":"Lime Coconut Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":2,"unit":"tbsp","name":"lime zest (about 3 limes)"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":85,"unit":"g","name":"desiccated coconut"},{"amount":190,"unit":"ml","name":"coconut milk"},{"amount":60,"unit":"ml","name":"lime juice"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter, sugar and zest; add eggs one at a time.","Fold in flour and coconut alternately with coconut milk and lime juice.","Bake 30–35 minutes until a skewer comes out clean.","Drizzle with lime glaze while warm."],"notes":""},{"id":"bake-earl-grey","title":"Earl Grey Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":125,"unit":"ml","name":"milk, infused hot with 4 Earl Grey tea bags, cooled"},{"amount":250,"unit":"g","name":"butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":4,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":1,"unit":"tsp","name":"vanilla extract"}],"steps":["Heat milk to steaming, add tea bags, steep 15 minutes and cool. Squeeze out the bags.","Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter, sugar and vanilla; add eggs one at a time.","Fold in flour alternately with the tea-infused milk.","Bake 30–35 minutes. Lovely with honey or lemon buttercream."],"notes":""},{"id":"bake-ginger-cake","title":"Ginger Cake","category":"Cakes","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":150,"unit":"g","name":"butter"},{"amount":175,"unit":"g","name":"brown sugar"},{"amount":115,"unit":"g","name":"golden syrup"},{"amount":2,"unit":"","name":"eggs"},{"amount":250,"unit":"ml","name":"milk"},{"amount":300,"unit":"g","name":"plain flour"},{"amount":1,"unit":"tbsp","name":"ground ginger"},{"amount":2,"unit":"tsp","name":"mixed spice"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Melt butter, sugar and golden syrup; cool slightly.","Whisk in eggs and milk.","Sift flour, spices and bicarb; whisk in the wet mixture until smooth.","Bake 35–40 minutes. Improves overnight — ice with lemon icing."],"notes":""},{"id":"bake-victoria-sponge","title":"Victoria Sponge","category":"Cakes","time":"22–25 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":225,"unit":"g","name":"butter, softened"},{"amount":225,"unit":"g","name":"caster sugar"},{"amount":4,"unit":"","name":"eggs"},{"amount":225,"unit":"g","name":"self-raising flour"},{"amount":1,"unit":"tsp","name":"baking powder"},{"amount":2,"unit":"tbsp","name":"milk"},{"amount":160,"unit":"g","name":"raspberry jam (to fill)"},{"amount":300,"unit":"ml","name":"thickened cream, whipped (to fill)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Beat butter and sugar until very pale; add eggs one at a time.","Fold in flour and baking powder with the milk until just combined.","Bake 22–25 minutes until springy. Cool completely.","Sandwich with jam and whipped cream; dust with icing sugar."],"notes":""},{"id":"bake-choc-beetroot","title":"Chocolate Beetroot Cake","category":"Cakes","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"dark chocolate, melted"},{"amount":175,"unit":"ml","name":"vegetable oil"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":250,"unit":"g","name":"cooked beetroot, finely grated"},{"amount":200,"unit":"g","name":"plain flour"},{"amount":40,"unit":"g","name":"cocoa powder"},{"amount":2,"unit":"tsp","name":"baking powder"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Whisk oil, sugar and eggs; stir in melted chocolate and beetroot.","Fold in flour, cocoa and baking powder.","Bake 35–40 minutes until a skewer comes out with moist crumbs.","Incredibly moist — finish with dark chocolate ganache."],"notes":""},{"id":"bake-weetbix-slice","title":"Chocolate Weet-Bix Slice","category":"Slices","time":"15–18 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":150,"unit":"g","name":"self-raising flour"},{"amount":90,"unit":"g","name":"desiccated coconut"},{"amount":60,"unit":"g","name":"Weet-Bix, crushed (about 4)"},{"amount":30,"unit":"g","name":"cocoa powder"},{"amount":100,"unit":"g","name":"caster sugar"},{"amount":180,"unit":"g","name":"butter, melted"},{"amount":240,"unit":"g","name":"icing sugar (icing)"},{"amount":30,"unit":"g","name":"cocoa powder (icing)"},{"amount":30,"unit":"g","name":"butter, softened (icing)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 20 × 30 cm slice tin.","Combine flour, coconut, Weet-Bix, cocoa and sugar; stir in melted butter.","Press firmly into the tin and bake 15–18 minutes.","Beat icing ingredients with 2–3 tbsp boiling water until smooth; spread over the warm slice.","Sprinkle with coconut and cut once cool."],"notes":""},{"id":"bake-vanilla-custard-slice","title":"Vanilla Custard Slice","category":"Slices","time":"Pastry 15 min + set 4 hrs","temp":"190°C fan-forced (pastry)","scaling":"pan","basePan":{"shape":"square","side":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":2,"unit":"","name":"sheets frozen puff pastry, thawed"},{"amount":750,"unit":"ml","name":"milk"},{"amount":110,"unit":"g","name":"caster sugar"},{"amount":60,"unit":"g","name":"cornflour"},{"amount":60,"unit":"g","name":"custard powder"},{"amount":60,"unit":"g","name":"butter"},{"amount":2,"unit":"","name":"egg yolks"},{"amount":2,"unit":"tsp","name":"vanilla extract"},{"amount":240,"unit":"g","name":"icing sugar (passionfruit icing)"},{"amount":60,"unit":"g","name":"passionfruit pulp (icing)"}],"steps":["Bake pastry sheets between two trays at 190°C fan-forced for 15 minutes until golden and flat. Trim to fit a lined 20 cm square tin.","Whisk sugar, cornflour and custard powder with a splash of the milk to a paste; add remaining milk.","Stir over medium heat until very thick; beat in butter, yolks and vanilla.","Pour hot custard over the base pastry sheet in the tin; top with the second sheet, pressing gently.","Mix icing sugar and passionfruit; spread over the top. Refrigerate 4 hours and cut with a serrated knife."],"notes":""},{"id":"bake-jelly-slice","title":"Jelly Slice","category":"Slices","time":"Set 4+ hrs","temp":"No bake — refrigerate","scaling":"pan","basePan":{"shape":"rectangle","length":28,"width":18,"quantity":1},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"Marie biscuits, crushed"},{"amount":125,"unit":"g","name":"butter, melted"},{"amount":395,"unit":"g","name":"sweetened condensed milk (1 tin)"},{"amount":15,"unit":"g","name":"gelatine powder (middle layer)"},{"amount":60,"unit":"ml","name":"lemon juice"},{"amount":125,"unit":"ml","name":"boiling water (middle layer)"},{"amount":85,"unit":"g","name":"raspberry jelly crystals (1 packet)"},{"amount":450,"unit":"ml","name":"boiling water (jelly layer)"}],"steps":["Line the tin. Mix biscuit crumbs and melted butter; press in firmly and chill 30 minutes.","Dissolve gelatine in the 125 ml boiling water. Whisk with condensed milk and lemon juice; pour over the base and chill until set.","Dissolve jelly crystals in the 450 ml boiling water; cool to room temperature.","Gently pour the cooled jelly over the set middle layer.","Refrigerate 4 hours. Cut with a hot knife."],"notes":""},{"id":"bake-peppermint-slice","title":"Peppermint Slice","category":"Slices","time":"Base 15 min + set","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"plain flour"},{"amount":45,"unit":"g","name":"cocoa powder"},{"amount":90,"unit":"g","name":"caster sugar"},{"amount":150,"unit":"g","name":"butter, melted"},{"amount":300,"unit":"g","name":"icing sugar (filling)"},{"amount":30,"unit":"g","name":"copha, melted (filling)"},{"amount":2,"unit":"tsp","name":"peppermint essence"},{"amount":40,"unit":"ml","name":"milk (filling)"},{"amount":200,"unit":"g","name":"dark chocolate (topping)"},{"amount":30,"unit":"g","name":"copha (topping)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the tin.","Mix flour, cocoa, sugar and melted butter; press into the tin and bake 15 minutes. Cool.","Beat icing sugar, melted copha, peppermint and milk to a smooth paste; spread over the base and chill 30 minutes.","Melt chocolate with copha; spread over the mint layer.","Refrigerate until set; cut with a hot knife."],"notes":""},{"id":"bake-muesli-slice","title":"Muesli Slice","category":"Slices","time":"20–25 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":125,"unit":"g","name":"butter"},{"amount":90,"unit":"g","name":"honey"},{"amount":60,"unit":"g","name":"brown sugar"},{"amount":200,"unit":"g","name":"rolled oats"},{"amount":60,"unit":"g","name":"desiccated coconut"},{"amount":75,"unit":"g","name":"dried fruit (sultanas, apricots, cranberries)"},{"amount":50,"unit":"g","name":"mixed seeds (pepitas, sunflower)"},{"amount":75,"unit":"g","name":"self-raising flour"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the tin.","Melt butter, honey and sugar together.","Combine oats, coconut, fruit, seeds and flour; stir in the butter mixture.","Press firmly into the tin and bake 20–25 minutes until golden.","Cool completely in the tin before cutting — it firms as it cools."],"notes":""},{"id":"bake-coconut-jam-slice","title":"Coconut Jam Slice","category":"Slices","time":"Base 15 min + top 25 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":185,"unit":"g","name":"self-raising flour"},{"amount":55,"unit":"g","name":"caster sugar (base)"},{"amount":125,"unit":"g","name":"butter, melted"},{"amount":220,"unit":"g","name":"strawberry jam"},{"amount":2,"unit":"","name":"eggs lightly beaten (topping)"},{"amount":110,"unit":"g","name":"caster sugar (topping)"},{"amount":200,"unit":"g","name":"desiccated coconut"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the tin.","Mix flour, sugar and melted butter; press into the tin and bake 15 minutes.","Spread jam over the warm base.","Combine eggs, sugar and coconut; press gently over the jam.","Bake 25 minutes until golden. Cool before slicing."],"notes":""},{"id":"bake-nutella-slice","title":"Nutella Hazelnut Slice","category":"Slices","time":"25–28 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"square","side":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":300,"unit":"g","name":"Nutella"},{"amount":2,"unit":"","name":"eggs"},{"amount":125,"unit":"g","name":"plain flour"},{"amount":100,"unit":"g","name":"hazelnuts, roughly chopped"},{"amount":1,"unit":"tsp","name":"vanilla extract"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 20 cm square tin.","Beat Nutella, eggs and vanilla until smooth.","Fold in flour and half the hazelnuts.","Spread into the tin, scatter remaining hazelnuts on top.","Bake 25–28 minutes until just set. Cool completely — it's fudgy like a brownie."],"notes":""},{"id":"bake-passionfruit-slice","title":"Passionfruit Slice","category":"Slices","time":"Base 12 min + top 15 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":150,"unit":"g","name":"self-raising flour"},{"amount":85,"unit":"g","name":"desiccated coconut"},{"amount":110,"unit":"g","name":"caster sugar"},{"amount":125,"unit":"g","name":"butter, melted"},{"amount":395,"unit":"g","name":"sweetened condensed milk (1 tin)"},{"amount":2,"unit":"","name":"egg yolks"},{"amount":80,"unit":"g","name":"passionfruit pulp"},{"amount":30,"unit":"ml","name":"lemon juice"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the tin.","Mix flour, coconut, sugar and melted butter; press into the tin and bake 12 minutes.","Whisk condensed milk, yolks, passionfruit and lemon juice.","Pour over the hot base and bake a further 15 minutes until just set.","Cool, then refrigerate before cutting."],"notes":""},{"id":"bake-apricot-slice","title":"Apricot Coconut Slice (No-Bake)","category":"Slices","time":"Set 2 hrs","temp":"No bake — refrigerate","scaling":"pan","basePan":{"shape":"rectangle","length":28,"width":18,"quantity":1},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"Marie biscuits, crushed"},{"amount":200,"unit":"g","name":"dried apricots, finely chopped"},{"amount":95,"unit":"g","name":"desiccated coconut, plus extra to coat"},{"amount":395,"unit":"g","name":"sweetened condensed milk (1 tin)"},{"amount":90,"unit":"g","name":"butter, melted"}],"steps":["Line the tin with baking paper.","Combine biscuit crumbs, apricots and coconut.","Stir in condensed milk and melted butter until well combined.","Press firmly into the tin, sprinkle with extra coconut and refrigerate 2 hours.","Cut into fingers. Keeps a week in the fridge."],"notes":""},{"id":"bake-date-slice","title":"Date Slice","category":"Slices","time":"25 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":350,"unit":"g","name":"pitted dates, chopped"},{"amount":125,"unit":"ml","name":"water"},{"amount":1,"unit":"tsp","name":"lemon zest"},{"amount":250,"unit":"g","name":"self-raising flour"},{"amount":100,"unit":"g","name":"caster sugar"},{"amount":150,"unit":"g","name":"butter, chilled and cubed"},{"amount":1,"unit":"","name":"eggs lightly beaten"}],"steps":["Simmer dates, water and zest until thick and jammy; cool.","Preheat oven to 160°C fan-forced. Grease and line the tin.","Rub butter into flour and sugar; stir in the egg to form a crumbly dough.","Press half into the tin, spread with date filling, crumble the rest on top.","Bake 25 minutes until golden. Dust with icing sugar once cool."],"notes":""},{"id":"bake-rocky-road","title":"Rocky Road","category":"Slices","time":"Set 1–2 hrs","temp":"No bake — refrigerate","scaling":"pan","basePan":{"shape":"square","side":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":350,"unit":"g","name":"milk chocolate, chopped"},{"amount":30,"unit":"g","name":"copha"},{"amount":150,"unit":"g","name":"marshmallows, halved"},{"amount":100,"unit":"g","name":"raspberry lollies, halved"},{"amount":60,"unit":"g","name":"roasted peanuts"},{"amount":45,"unit":"g","name":"desiccated coconut"}],"steps":["Line a 20 cm square tin.","Melt chocolate and copha together; cool 5 minutes.","Toss marshmallows, lollies, peanuts and coconut in a bowl.","Pour over the chocolate and fold to coat; press into the tin.","Refrigerate 1–2 hours until firm; cut into chunks."],"notes":""},{"id":"bake-ginger-slice","title":"Ginger Crunch Slice","category":"Slices","time":"20 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":225,"unit":"g","name":"plain flour"},{"amount":110,"unit":"g","name":"caster sugar"},{"amount":1,"unit":"tsp","name":"ground ginger (base)"},{"amount":1,"unit":"tsp","name":"baking powder"},{"amount":150,"unit":"g","name":"butter, melted (base)"},{"amount":90,"unit":"g","name":"butter (icing)"},{"amount":240,"unit":"g","name":"icing sugar"},{"amount":60,"unit":"g","name":"golden syrup"},{"amount":3,"unit":"tsp","name":"ground ginger (icing)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the tin.","Mix flour, sugar, ginger, baking powder and melted butter; press into the tin.","Bake 20 minutes until light golden.","Melt icing ingredients together, stirring until smooth; pour over the hot base.","Cool in the tin, then cut while the icing is just set."],"notes":""},{"id":"bake-marshmallow-slice","title":"Marshmallow Slice","category":"Slices","time":"Base 15–18 min + set","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"plain flour"},{"amount":90,"unit":"g","name":"caster sugar (base)"},{"amount":125,"unit":"g","name":"butter, melted"},{"amount":28,"unit":"g","name":"gelatine powder"},{"amount":440,"unit":"g","name":"caster sugar (marshmallow)"},{"amount":375,"unit":"ml","name":"water"},{"amount":1,"unit":"tsp","name":"vanilla extract"},{"amount":45,"unit":"g","name":"desiccated coconut, toasted (topping)"}],"steps":["Preheat oven to 160°C fan-forced. Line the tin. Mix base ingredients, press in and bake 15–18 minutes. Cool.","Sprinkle gelatine over half the water; stand 5 minutes.","Boil sugar with remaining water 5 minutes; add gelatine mixture and boil 2 more.","Cool 10 minutes, add vanilla, then beat with a stand mixer 8–10 minutes until thick and fluffy.","Spread over the base, top with coconut and set 2 hours before cutting."],"notes":""},{"id":"bake-millionaires","title":"Millionaire's Shortbread","category":"Slices","time":"Base 20 min + caramel","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"plain flour"},{"amount":80,"unit":"g","name":"caster sugar"},{"amount":175,"unit":"g","name":"butter, softened (base)"},{"amount":395,"unit":"g","name":"sweetened condensed milk (1 tin)"},{"amount":100,"unit":"g","name":"butter (caramel)"},{"amount":60,"unit":"g","name":"golden syrup"},{"amount":200,"unit":"g","name":"milk chocolate (topping)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the tin.","Rub butter into flour and sugar; press into the tin and bake 20 minutes until pale golden.","Stir condensed milk, butter and syrup over low heat 10 minutes until thick and golden; pour over the base.","Cool, then top with melted chocolate.","Refrigerate until set; cut with a hot knife."],"notes":""},{"id":"bake-cherry-ripe-slice","title":"Cherry Ripe Slice","category":"Slices","time":"Set 3 hrs","temp":"No bake — refrigerate","scaling":"pan","basePan":{"shape":"rectangle","length":28,"width":18,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"chocolate ripple biscuits, crushed"},{"amount":100,"unit":"g","name":"butter, melted"},{"amount":395,"unit":"g","name":"sweetened condensed milk (1 tin)"},{"amount":200,"unit":"g","name":"glacé cherries, chopped"},{"amount":180,"unit":"g","name":"desiccated coconut"},{"amount":0.5,"unit":"tsp","name":"pink food colouring"},{"amount":200,"unit":"g","name":"dark chocolate (topping)"},{"amount":30,"unit":"g","name":"copha"}],"steps":["Line the tin. Mix biscuit crumbs and melted butter; press in and chill 20 minutes.","Combine condensed milk, cherries, coconut and colouring; spread over the base.","Chill 1 hour until firm.","Melt chocolate and copha; spread over the cherry layer.","Refrigerate until set; slice with a hot knife."],"notes":""},{"id":"bake-honey-joys","title":"Honey Joys","category":"Slices","time":"10 min","temp":"140°C fan-forced","scaling":"batch","yield":"Makes 24","baseServings":1,"ingredients":[{"amount":90,"unit":"g","name":"butter"},{"amount":55,"unit":"g","name":"caster sugar"},{"amount":90,"unit":"g","name":"honey"},{"amount":120,"unit":"g","name":"corn flakes"}],"steps":["Preheat oven to 140°C fan-forced. Line two 12-hole patty pans with paper cases.","Melt butter, sugar and honey until frothy.","Fold through the corn flakes to coat.","Spoon into cases and bake 10 minutes.","Cool completely in the tins — they crisp as they set."],"notes":""},{"id":"bake-apple-crumble-slice","title":"Apple Crumble Slice","category":"Slices","time":"35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"self-raising flour (base)"},{"amount":110,"unit":"g","name":"caster sugar (base)"},{"amount":125,"unit":"g","name":"butter, melted (base)"},{"amount":1,"unit":"","name":"eggs (base)"},{"amount":800,"unit":"g","name":"tinned pie apple"},{"amount":1,"unit":"tsp","name":"ground cinnamon"},{"amount":100,"unit":"g","name":"plain flour (crumble)"},{"amount":90,"unit":"g","name":"brown sugar (crumble)"},{"amount":45,"unit":"g","name":"rolled oats (crumble)"},{"amount":80,"unit":"g","name":"butter, chilled (crumble)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the tin.","Mix base ingredients to a soft dough; press into the tin.","Toss apple with cinnamon and spread over the base.","Rub crumble butter into flour, sugar and oats; scatter over the apple.","Bake 35 minutes until golden. Cool before slicing."],"notes":""},{"id":"bake-melting-moments","title":"Melting Moments","category":"Biscuits & Cookies","time":"15 min","temp":"150°C fan-forced","scaling":"batch","yield":"Makes 14 sandwiched","baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"butter, softened"},{"amount":80,"unit":"g","name":"icing sugar"},{"amount":250,"unit":"g","name":"plain flour"},{"amount":60,"unit":"g","name":"cornflour"},{"amount":60,"unit":"g","name":"butter, softened (filling)"},{"amount":120,"unit":"g","name":"icing sugar (filling)"},{"amount":2,"unit":"tsp","name":"lemon juice (filling)"},{"amount":1,"unit":"tsp","name":"lemon zest (filling)"}],"steps":["Preheat oven to 150°C fan-forced. Line two trays.","Beat butter and icing sugar until very pale; fold in flours.","Roll into 28 balls, place on trays and flatten gently with a floured fork.","Bake 15 minutes until just firm; cool on trays.","Beat filling ingredients until fluffy; sandwich pairs together."],"notes":""},{"id":"bake-gingerbread","title":"Gingerbread Biscuits","category":"Biscuits & Cookies","time":"10–12 min","temp":"160°C fan-forced","scaling":"batch","yield":"Makes about 30","baseServings":1,"ingredients":[{"amount":125,"unit":"g","name":"butter, softened"},{"amount":100,"unit":"g","name":"brown sugar"},{"amount":125,"unit":"g","name":"golden syrup"},{"amount":1,"unit":"","name":"egg yolk"},{"amount":300,"unit":"g","name":"plain flour"},{"amount":1,"unit":"tbsp","name":"ground ginger"},{"amount":1,"unit":"tsp","name":"mixed spice"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"}],"steps":["Beat butter, sugar and golden syrup until pale; beat in the yolk.","Fold in flour, spices and bicarb; knead lightly, wrap and chill 30 minutes.","Preheat oven to 160°C fan-forced. Roll out to 4 mm and cut shapes.","Bake 10–12 minutes until just golden at the edges.","Cool on trays; decorate with royal icing if you like."],"notes":""},{"id":"bake-jam-drops","title":"Jam Drops","category":"Biscuits & Cookies","time":"15 min","temp":"160°C fan-forced","scaling":"batch","yield":"Makes 24","baseServings":1,"ingredients":[{"amount":185,"unit":"g","name":"butter, softened"},{"amount":110,"unit":"g","name":"caster sugar"},{"amount":1,"unit":"","name":"eggs"},{"amount":1,"unit":"tsp","name":"vanilla extract"},{"amount":260,"unit":"g","name":"plain flour"},{"amount":40,"unit":"g","name":"custard powder"},{"amount":80,"unit":"g","name":"raspberry jam"}],"steps":["Preheat oven to 160°C fan-forced. Line two trays.","Cream butter and sugar; beat in egg and vanilla.","Fold in flour and custard powder.","Roll into 24 balls, make a deep dimple in each with your thumb and fill with ½ tsp jam.","Bake 15 minutes until pale golden. Cool on trays — the jam is lava-hot."],"notes":""},{"id":"bake-monte-carlos","title":"Monte Carlos","category":"Biscuits & Cookies","time":"12 min","temp":"160°C fan-forced","scaling":"batch","yield":"Makes 18 sandwiched","baseServings":1,"ingredients":[{"amount":185,"unit":"g","name":"butter, softened"},{"amount":95,"unit":"g","name":"brown sugar"},{"amount":1,"unit":"","name":"eggs"},{"amount":185,"unit":"g","name":"self-raising flour"},{"amount":90,"unit":"g","name":"plain flour"},{"amount":45,"unit":"g","name":"desiccated coconut"},{"amount":60,"unit":"g","name":"butter (filling)"},{"amount":120,"unit":"g","name":"icing sugar (filling)"},{"amount":1,"unit":"tsp","name":"vanilla (filling)"},{"amount":110,"unit":"g","name":"raspberry jam (filling)"}],"steps":["Preheat oven to 160°C fan-forced. Line two trays.","Cream butter and sugar; beat in egg.","Fold in flours and coconut; roll into 36 small ovals and rough the tops with a fork.","Bake 12 minutes until golden; cool.","Beat butter, icing sugar and vanilla; sandwich biscuits with cream and a smear of jam."],"notes":""},{"id":"bake-yoyos","title":"Yo-Yos","category":"Biscuits & Cookies","time":"15–18 min","temp":"150°C fan-forced","scaling":"batch","yield":"Makes 12 sandwiched","baseServings":1,"ingredients":[{"amount":175,"unit":"g","name":"butter, softened"},{"amount":60,"unit":"g","name":"icing sugar"},{"amount":150,"unit":"g","name":"plain flour"},{"amount":90,"unit":"g","name":"custard powder"},{"amount":50,"unit":"g","name":"butter, softened (filling)"},{"amount":100,"unit":"g","name":"icing sugar (filling)"},{"amount":2,"unit":"tsp","name":"custard powder (filling)"}],"steps":["Preheat oven to 150°C fan-forced. Line two trays.","Beat butter and icing sugar until pale; fold in flour and custard powder.","Roll into 24 balls, flatten slightly with a fork.","Bake 15–18 minutes until firm but not coloured; cool.","Beat filling until fluffy and sandwich pairs together."],"notes":""},{"id":"bake-macarons","title":"Chocolate Macarons","category":"Biscuits & Cookies","time":"15–18 min","temp":"130°C fan-forced","scaling":"batch","yield":"Makes about 20","baseServings":1,"ingredients":[{"amount":100,"unit":"g","name":"egg whites (about 3), room temperature"},{"amount":50,"unit":"g","name":"caster sugar"},{"amount":110,"unit":"g","name":"almond meal"},{"amount":200,"unit":"g","name":"icing sugar"},{"amount":15,"unit":"g","name":"cocoa powder"},{"amount":100,"unit":"g","name":"dark chocolate (ganache)"},{"amount":100,"unit":"ml","name":"thickened cream (ganache)"}],"steps":["Sift almond meal, icing sugar and cocoa twice.","Whisk whites to soft peaks; gradually add caster sugar to a glossy meringue.","Fold in the dry mix until the batter flows like slow lava (macaronage).","Pipe 4 cm rounds onto lined trays; rest 30–45 minutes until a skin forms. Bake at 130°C fan-forced 15–18 minutes.","Heat cream, pour over chocolate, stir smooth; cool and sandwich the shells. Best after 24 hours in the fridge."],"notes":""},{"id":"bake-meringue-kisses","title":"Meringue Kisses","category":"Biscuits & Cookies","time":"60–75 min","temp":"100°C fan-forced","scaling":"batch","yield":"Makes about 30","baseServings":1,"ingredients":[{"amount":140,"unit":"g","name":"egg whites (about 4), room temperature"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":1,"unit":"tsp","name":"cornflour"},{"amount":0.5,"unit":"tsp","name":"white vinegar"}],"steps":["Preheat oven to 100°C fan-forced. Line two trays.","Whisk whites to soft peaks; add sugar a tablespoon at a time until thick and glossy.","Whisk in cornflour and vinegar.","Pipe small kisses onto the trays.","Bake 60–75 minutes until crisp and dry; cool in the oven with the door ajar."],"notes":""},{"id":"bake-oat-sultana","title":"Oat & Sultana Biscuits","category":"Biscuits & Cookies","time":"12–14 min","temp":"160°C fan-forced","scaling":"batch","yield":"Makes 20","baseServings":1,"ingredients":[{"amount":125,"unit":"g","name":"butter, softened"},{"amount":100,"unit":"g","name":"brown sugar"},{"amount":1,"unit":"","name":"eggs"},{"amount":20,"unit":"g","name":"golden syrup"},{"amount":135,"unit":"g","name":"self-raising flour"},{"amount":90,"unit":"g","name":"rolled oats"},{"amount":80,"unit":"g","name":"sultanas"}],"steps":["Preheat oven to 160°C fan-forced. Line two trays.","Cream butter and sugar; beat in egg and golden syrup.","Fold in flour, oats and sultanas.","Roll tablespoons of dough, flatten slightly, space 5 cm apart.","Bake 12–14 minutes until golden. Cool on trays."],"notes":""},{"id":"bake-double-choc-cookies","title":"Double Choc Cookies","category":"Biscuits & Cookies","time":"12 min","temp":"160°C fan-forced","scaling":"batch","yield":"Makes 18","baseServings":1,"ingredients":[{"amount":125,"unit":"g","name":"butter, softened"},{"amount":165,"unit":"g","name":"brown sugar"},{"amount":1,"unit":"","name":"eggs"},{"amount":1,"unit":"tsp","name":"vanilla extract"},{"amount":165,"unit":"g","name":"plain flour"},{"amount":40,"unit":"g","name":"cocoa powder"},{"amount":0.5,"unit":"tsp","name":"bicarbonate of soda"},{"amount":150,"unit":"g","name":"white choc chips"}],"steps":["Preheat oven to 160°C fan-forced. Line two trays.","Cream butter and sugar; beat in egg and vanilla.","Fold in flour, cocoa and bicarb, then choc chips.","Roll tablespoons of dough, space well apart.","Bake 12 minutes — they should still look slightly soft. Cool on trays."],"notes":""},{"id":"bake-lemon-meringue","title":"Lemon Meringue Tart","category":"Tarts & Pastries","time":"Shell 25 min + meringue 10 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":23,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"plain flour (pastry)"},{"amount":100,"unit":"g","name":"butter, chilled (pastry)"},{"amount":55,"unit":"g","name":"icing sugar (pastry)"},{"amount":1,"unit":"","name":"egg yolk (pastry)"},{"amount":60,"unit":"g","name":"cornflour"},{"amount":250,"unit":"ml","name":"water"},{"amount":110,"unit":"g","name":"caster sugar (filling)"},{"amount":125,"unit":"ml","name":"lemon juice"},{"amount":2,"unit":"tbsp","name":"lemon zest"},{"amount":3,"unit":"","name":"egg yolks (filling)"},{"amount":60,"unit":"g","name":"butter (filling)"},{"amount":3,"unit":"","name":"egg whites (meringue)"},{"amount":165,"unit":"g","name":"caster sugar (meringue)"}],"steps":["Blitz pastry ingredients with 1–2 tbsp cold water; chill 30 minutes, then line a 23 cm tart tin. Blind bake at 160°C fan-forced 25 minutes.","Whisk cornflour, water, sugar, juice and zest over heat until very thick; beat in yolks and butter. Pour into the shell.","Whisk whites to soft peaks, gradually add sugar to a glossy meringue.","Pile onto the filling, sealing to the pastry edge, and swirl.","Bake 10 minutes until golden. Cool before slicing."],"notes":""},{"id":"bake-portuguese-tarts","title":"Portuguese Custard Tarts","category":"Tarts & Pastries","time":"20–25 min","temp":"200°C fan-forced","scaling":"batch","yield":"Makes 12","baseServings":1,"ingredients":[{"amount":2,"unit":"","name":"sheets frozen puff pastry, thawed"},{"amount":375,"unit":"ml","name":"milk"},{"amount":110,"unit":"g","name":"caster sugar"},{"amount":30,"unit":"g","name":"cornflour"},{"amount":5,"unit":"","name":"egg yolks"},{"amount":2,"unit":"tsp","name":"vanilla extract"},{"amount":1,"unit":"","name":"cinnamon stick"}],"steps":["Whisk cornflour and sugar with a little milk to a paste; add remaining milk, yolks and cinnamon stick.","Stir over medium heat until thick; remove cinnamon, add vanilla, cover surface with cling wrap and cool.","Preheat oven to 200°C fan-forced. Roll each pastry sheet into a log, cut into 6, and press each spiral into a greased muffin hole.","Fill each case three-quarters with custard.","Bake 20–25 minutes until blistered and dark golden on top. Best warm."],"notes":""},{"id":"bake-fruit-tart","title":"Fresh Fruit Tart","category":"Tarts & Pastries","time":"Shell 25 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":23,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"plain flour (pastry)"},{"amount":100,"unit":"g","name":"butter, chilled (pastry)"},{"amount":55,"unit":"g","name":"icing sugar (pastry)"},{"amount":1,"unit":"","name":"egg yolk (pastry)"},{"amount":500,"unit":"ml","name":"milk (crème pâtissière)"},{"amount":4,"unit":"","name":"egg yolks (crème pâtissière)"},{"amount":110,"unit":"g","name":"caster sugar"},{"amount":40,"unit":"g","name":"cornflour"},{"amount":2,"unit":"tsp","name":"vanilla extract"},{"amount":30,"unit":"g","name":"butter (crème pâtissière)"},{"amount":400,"unit":"g","name":"mixed fresh fruit (berries, kiwi, peach)"},{"amount":60,"unit":"g","name":"apricot jam, warmed (glaze)"}],"steps":["Make pastry as for lemon meringue tart; blind bake in a 23 cm tin at 160°C fan-forced 25 minutes and cool.","Whisk yolks, sugar and cornflour; whisk in hot milk, return to the pan and stir until thick. Beat in vanilla and butter; chill.","Spread crème pâtissière into the shell.","Arrange fruit on top.","Brush with warmed, sieved apricot jam to glaze."],"notes":""},{"id":"bake-choc-ganache-tart","title":"Chocolate Ganache Tart","category":"Tarts & Pastries","time":"Shell 25 min + set 2 hrs","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":23,"quantity":1},"baseServings":1,"ingredients":[{"amount":180,"unit":"g","name":"plain flour (pastry)"},{"amount":20,"unit":"g","name":"cocoa powder (pastry)"},{"amount":100,"unit":"g","name":"butter, chilled"},{"amount":55,"unit":"g","name":"icing sugar"},{"amount":1,"unit":"","name":"egg yolk"},{"amount":300,"unit":"g","name":"dark chocolate, chopped (ganache)"},{"amount":300,"unit":"ml","name":"thickened cream"},{"amount":30,"unit":"g","name":"butter (ganache)"}],"steps":["Blitz pastry ingredients with 1–2 tbsp cold water; chill, line a 23 cm tart tin and blind bake at 160°C fan-forced 25 minutes. Cool.","Heat cream to just below boiling; pour over chocolate and stand 2 minutes.","Stir until smooth; stir in butter for shine.","Pour into the shell.","Set at room temperature 2 hours. Serve with sea salt flakes and cream."],"notes":""},{"id":"bake-frangipane","title":"Pear Frangipane Tart","category":"Tarts & Pastries","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":23,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"plain flour (pastry)"},{"amount":100,"unit":"g","name":"butter, chilled (pastry)"},{"amount":55,"unit":"g","name":"icing sugar (pastry)"},{"amount":1,"unit":"","name":"egg yolk (pastry)"},{"amount":125,"unit":"g","name":"butter, softened (frangipane)"},{"amount":110,"unit":"g","name":"caster sugar"},{"amount":2,"unit":"","name":"eggs"},{"amount":125,"unit":"g","name":"almond meal"},{"amount":25,"unit":"g","name":"plain flour (frangipane)"},{"amount":410,"unit":"g","name":"tinned pear halves, drained and sliced"},{"amount":20,"unit":"g","name":"flaked almonds"}],"steps":["Make and blind bake the pastry shell in a 23 cm tin at 160°C fan-forced 20 minutes.","Beat butter and sugar; add eggs one at a time, then fold in almond meal and flour.","Spread frangipane into the shell and fan the pear slices over the top.","Scatter with flaked almonds.","Bake 35–40 minutes until golden and set. Dust with icing sugar."],"notes":""},{"id":"bake-sausage-rolls","title":"Sausage Rolls","category":"Tarts & Pastries","time":"25 min","temp":"190°C fan-forced","scaling":"batch","yield":"Makes 24 party size","baseServings":1,"ingredients":[{"amount":2,"unit":"","name":"sheets frozen puff pastry, thawed"},{"amount":500,"unit":"g","name":"sausage mince"},{"amount":1,"unit":"","name":"small onion, grated"},{"amount":1,"unit":"","name":"carrot, finely grated"},{"amount":40,"unit":"g","name":"breadcrumbs"},{"amount":2,"unit":"","name":"eggs (one in the mix, one to glaze)"},{"amount":1,"unit":"tsp","name":"dried mixed herbs"}],"steps":["Preheat oven to 190°C fan-forced. Line two trays.","Mix mince, onion, carrot, breadcrumbs, one egg and herbs.","Halve each pastry sheet; shape a log of filling along each and roll up, seam down.","Cut each roll into 6, brush with beaten egg and snip a small vent in each.","Bake 25 minutes until puffed and deep golden."],"notes":""},{"id":"bake-profiteroles","title":"Profiteroles (Choux)","category":"Tarts & Pastries","time":"25 min + 10 min","temp":"190°C fan-forced","scaling":"batch","yield":"Makes 24","baseServings":1,"ingredients":[{"amount":125,"unit":"ml","name":"water"},{"amount":125,"unit":"ml","name":"milk"},{"amount":100,"unit":"g","name":"butter"},{"amount":150,"unit":"g","name":"plain flour"},{"amount":4,"unit":"","name":"eggs"},{"amount":300,"unit":"ml","name":"thickened cream, whipped (filling)"},{"amount":100,"unit":"g","name":"dark chocolate, melted (topping)"}],"steps":["Preheat oven to 190°C fan-forced. Line two trays.","Boil water, milk and butter; dump in flour and beat over heat until the dough pulls away from the pan. Cool 5 minutes.","Beat in eggs one at a time until glossy and pipeable.","Pipe 24 rounds; bake 25 minutes, then reduce to 160°C fan-forced for 10 minutes to dry out. Cool.","Fill with whipped cream and top with melted chocolate."],"notes":""},{"id":"bake-apple-pie","title":"Apple Pie","category":"Tarts & Pastries","time":"45–50 min","temp":"180°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":23,"quantity":1},"baseServings":1,"ingredients":[{"amount":300,"unit":"g","name":"plain flour (pastry)"},{"amount":150,"unit":"g","name":"butter, chilled"},{"amount":55,"unit":"g","name":"caster sugar (pastry)"},{"amount":1,"unit":"","name":"eggs (pastry)"},{"amount":1000,"unit":"g","name":"apples, peeled and sliced (about 6)"},{"amount":110,"unit":"g","name":"caster sugar (filling)"},{"amount":20,"unit":"g","name":"cornflour"},{"amount":1,"unit":"tsp","name":"ground cinnamon"},{"amount":1,"unit":"","name":"egg white + raw sugar to finish"}],"steps":["Blitz pastry ingredients with 1–2 tbsp cold water; chill 30 minutes.","Simmer apples with sugar 5 minutes; stir in cornflour and cinnamon, cook until thick. Cool.","Preheat oven to 180°C fan-forced. Line a 23 cm pie dish with two-thirds of the pastry; fill with apple.","Top with the remaining pastry, crimp edges, brush with egg white, scatter raw sugar and cut vents.","Bake 45–50 minutes until deep golden."],"notes":""},{"id":"bake-blueberry-muffins","title":"Blueberry Muffins","category":"Loaves, Muffins & Other","time":"20–22 min","temp":"170°C fan-forced","scaling":"batch","yield":"Makes 12","baseServings":1,"ingredients":[{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":165,"unit":"g","name":"caster sugar"},{"amount":1,"unit":"","name":"eggs"},{"amount":250,"unit":"ml","name":"milk"},{"amount":90,"unit":"g","name":"butter, melted"},{"amount":250,"unit":"g","name":"blueberries (fresh or frozen)"}],"steps":["Preheat oven to 170°C fan-forced. Line a 12-hole muffin tin.","Combine flour and sugar in a large bowl.","Whisk egg, milk and melted butter; fold into the dry mix until only just combined — lumps are fine.","Fold through blueberries and divide between cases.","Bake 20–22 minutes until golden and springy."],"notes":""},{"id":"bake-choc-chip-muffins","title":"Choc Chip Muffins","category":"Loaves, Muffins & Other","time":"20 min","temp":"170°C fan-forced","scaling":"batch","yield":"Makes 12","baseServings":1,"ingredients":[{"amount":280,"unit":"g","name":"self-raising flour"},{"amount":30,"unit":"g","name":"cocoa powder"},{"amount":165,"unit":"g","name":"caster sugar"},{"amount":1,"unit":"","name":"eggs"},{"amount":250,"unit":"ml","name":"milk"},{"amount":100,"unit":"g","name":"butter, melted"},{"amount":190,"unit":"g","name":"dark choc chips"}],"steps":["Preheat oven to 170°C fan-forced. Line a 12-hole muffin tin.","Sift flour and cocoa; stir in sugar.","Whisk egg, milk and butter; fold in until just combined.","Fold through choc chips and divide between cases.","Bake 20 minutes until risen and springy."],"notes":""},{"id":"bake-scones","title":"Classic Scones","category":"Loaves, Muffins & Other","time":"12–15 min","temp":"200°C fan-forced","scaling":"batch","yield":"Makes 12","baseServings":1,"ingredients":[{"amount":450,"unit":"g","name":"self-raising flour"},{"amount":60,"unit":"g","name":"butter, chilled"},{"amount":30,"unit":"g","name":"caster sugar"},{"amount":0.5,"unit":"tsp","name":"salt"},{"amount":300,"unit":"ml","name":"milk, plus extra to brush"}],"steps":["Preheat oven to 200°C fan-forced. Line a tray.","Rub butter into flour, sugar and salt until it resembles crumbs.","Add milk and mix with a knife to a soft, sticky dough — handle as little as possible.","Pat out to 2.5 cm thick, cut rounds with a floured cutter and place close together on the tray.","Brush tops with milk and bake 12–15 minutes until risen and golden. Serve with jam and cream."],"notes":""},{"id":"bake-date-loaf","title":"Date & Walnut Loaf","category":"Loaves, Muffins & Other","time":"50–55 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":21,"width":11,"quantity":1},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"pitted dates, chopped"},{"amount":250,"unit":"ml","name":"boiling water"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"},{"amount":60,"unit":"g","name":"butter"},{"amount":155,"unit":"g","name":"brown sugar"},{"amount":1,"unit":"","name":"eggs"},{"amount":225,"unit":"g","name":"self-raising flour"},{"amount":60,"unit":"g","name":"walnuts, chopped"}],"steps":["Combine dates, boiling water, bicarb and butter; stand 10 minutes.","Preheat oven to 160°C fan-forced. Grease and line a 21 × 11 cm loaf tin.","Stir sugar and egg into the date mixture.","Fold in flour and walnuts.","Bake 50–55 minutes. Excellent toasted with butter."],"notes":""},{"id":"bake-zucchini-loaf","title":"Zucchini Walnut Loaf","category":"Loaves, Muffins & Other","time":"55–60 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":21,"width":11,"quantity":1},"baseServings":1,"ingredients":[{"amount":300,"unit":"g","name":"zucchini, grated and squeezed dry"},{"amount":250,"unit":"ml","name":"vegetable oil"},{"amount":200,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":1,"unit":"tsp","name":"ground cinnamon"},{"amount":60,"unit":"g","name":"walnuts, chopped"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 21 × 11 cm loaf tin.","Whisk oil, sugar and eggs.","Stir in zucchini, then fold in flour, cinnamon and walnuts.","Pour into the tin.","Bake 55–60 minutes until a skewer comes out clean."],"notes":""},{"id":"bake-blondies","title":"White Choc Macadamia Blondies","category":"Loaves, Muffins & Other","time":"28–32 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"square","side":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":175,"unit":"g","name":"butter, melted"},{"amount":200,"unit":"g","name":"brown sugar"},{"amount":2,"unit":"","name":"eggs"},{"amount":2,"unit":"tsp","name":"vanilla extract"},{"amount":175,"unit":"g","name":"plain flour"},{"amount":0.5,"unit":"tsp","name":"baking powder"},{"amount":150,"unit":"g","name":"white chocolate, chopped"},{"amount":75,"unit":"g","name":"macadamias, roughly chopped"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 20 cm square tin.","Whisk melted butter and sugar; whisk in eggs and vanilla.","Fold in flour and baking powder, then white chocolate and macadamias.","Spread into the tin.","Bake 28–32 minutes until golden but still soft in the centre. Cool before cutting."],"notes":""},{"id":"bake-pavlova","title":"Pavlova","category":"Loaves, Muffins & Other","time":"75–90 min + cooling","temp":"120°C fan-forced","scaling":"batch","yield":"One 22 cm pavlova","baseServings":1,"ingredients":[{"amount":210,"unit":"g","name":"egg whites (about 6), room temperature"},{"amount":330,"unit":"g","name":"caster sugar"},{"amount":3,"unit":"tsp","name":"cornflour"},{"amount":1,"unit":"tsp","name":"white vinegar"},{"amount":1,"unit":"tsp","name":"vanilla extract"},{"amount":300,"unit":"ml","name":"thickened cream, whipped (topping)"},{"amount":400,"unit":"g","name":"fresh fruit — passionfruit, berries, kiwi (topping)"}],"steps":["Preheat oven to 120°C fan-forced. Draw a 22 cm circle on baking paper on a tray.","Whisk whites to soft peaks; add sugar a tablespoon at a time until thick, glossy and no longer grainy.","Fold in cornflour, vinegar and vanilla.","Mound onto the circle, smooth the sides and swirl the top.","Bake 75–90 minutes until crisp; turn the oven off and cool completely inside with the door ajar. Top with cream and fruit just before serving."],"notes":""},{"id":"bake-baked-cheesecake","title":"Baked Cheesecake","category":"Loaves, Muffins & Other","time":"60–70 min + chill","temp":"140°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":22,"quantity":1},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"plain sweet biscuits, crushed"},{"amount":125,"unit":"g","name":"butter, melted"},{"amount":750,"unit":"g","name":"cream cheese, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":1,"unit":"tsp","name":"vanilla extract"},{"amount":60,"unit":"ml","name":"lemon juice"},{"amount":300,"unit":"ml","name":"sour cream"}],"steps":["Mix biscuit crumbs and melted butter; press into the base of a lined 22 cm springform tin. Chill 20 minutes.","Preheat oven to 140°C fan-forced.","Beat cream cheese and sugar until smooth; beat in eggs one at a time, then vanilla, lemon juice and sour cream.","Pour over the base and bake 60–70 minutes until just set with a slight wobble.","Cool in the oven with the door ajar, then refrigerate at least 4 hours."],"notes":""},{"id":"bake-cinnamon-tea-cake","title":"Cinnamon Tea Cake","category":"Loaves, Muffins & Other","time":"25–30 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":60,"unit":"g","name":"butter, softened"},{"amount":110,"unit":"g","name":"caster sugar"},{"amount":1,"unit":"","name":"eggs"},{"amount":1,"unit":"tsp","name":"vanilla extract"},{"amount":150,"unit":"g","name":"self-raising flour"},{"amount":80,"unit":"ml","name":"milk"},{"amount":20,"unit":"g","name":"butter, melted (topping)"},{"amount":1,"unit":"tbsp","name":"caster sugar mixed with 1 tsp cinnamon (topping)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 20 cm round pan.","Cream butter and sugar; beat in egg and vanilla.","Fold in flour alternately with milk.","Bake 25–30 minutes until a skewer comes out clean.","Brush the warm cake with melted butter and sprinkle with cinnamon sugar. Best eaten the day it's made."],"notes":""},{"id":"bake-friands","title":"Raspberry Friands","category":"Loaves, Muffins & Other","time":"20–25 min","temp":"170°C fan-forced","scaling":"batch","yield":"Makes 12","baseServings":1,"ingredients":[{"amount":210,"unit":"g","name":"egg whites (about 6), lightly whisked"},{"amount":185,"unit":"g","name":"butter, melted and cooled"},{"amount":240,"unit":"g","name":"icing sugar"},{"amount":120,"unit":"g","name":"almond meal"},{"amount":75,"unit":"g","name":"plain flour"},{"amount":100,"unit":"g","name":"raspberries (fresh or frozen)"}],"steps":["Preheat oven to 170°C fan-forced. Grease a 12-hole friand or muffin tin well.","Whisk egg whites until frothy (not peaks).","Fold in sifted icing sugar, almond meal and flour, then the melted butter.","Divide between holes and press 2–3 raspberries into each.","Bake 20–25 minutes until golden and springy. Dust with icing sugar."],"notes":""},{"id":"bake-red-velvet-cake","title":"Red Velvet Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":125,"unit":"g","name":"unsalted butter, softened"},{"amount":300,"unit":"g","name":"caster sugar"},{"amount":2,"unit":"","name":"eggs"},{"amount":1,"unit":"tbsp","name":"red liquid food colouring"},{"amount":335,"unit":"g","name":"plain flour"},{"amount":25,"unit":"g","name":"cocoa powder"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"},{"amount":250,"unit":"ml","name":"buttermilk"},{"amount":2,"unit":"tsp","name":"white vinegar"},{"amount":1,"unit":"tsp","name":"vanilla extract"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar until pale. Beat in eggs one at a time, then colouring and vanilla.","Sift flour, cocoa and bicarb. Fold in alternately with combined buttermilk and vinegar.","Divide between pans and bake 30–35 minutes until a skewer comes out clean.","Cool completely, then fill and ice with cream cheese frosting."],"notes":""},{"id":"bake-coffee-walnut-cake","title":"Coffee Walnut Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"unsalted butter, softened"},{"amount":200,"unit":"g","name":"brown sugar"},{"amount":4,"unit":"","name":"eggs"},{"amount":2,"unit":"tbsp","name":"instant coffee dissolved in 2 tbsp hot water"},{"amount":260,"unit":"g","name":"self-raising flour"},{"amount":100,"unit":"g","name":"walnuts, chopped"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar until fluffy; add eggs one at a time.","Beat in the cooled coffee mixture.","Fold in flour and walnuts; divide between pans.","Bake 30–35 minutes. Fill and top with coffee buttercream and walnut halves."],"notes":""},{"id":"bake-orange-almond-cake-flourless-","title":"Orange Almond Cake (Flourless)","category":"Cakes","time":"40–45 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":450,"unit":"g","name":"whole oranges (about 2)"},{"amount":6,"unit":"","name":"eggs"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":250,"unit":"g","name":"almond meal"},{"amount":1,"unit":"tsp","name":"baking powder"}],"steps":["Boil whole oranges in water for 1 hour until very soft. Cool, quarter, remove pips and blitz to a purée.","Preheat oven to 160°C fan-forced. Grease and line the pans.","Whisk eggs and sugar until pale and slightly thickened.","Fold in orange purée, almond meal and baking powder.","Bake 40–45 minutes until firm in the centre. Cool in pans — gluten free and better the next day."],"notes":""},{"id":"bake-marble-cake","title":"Marble Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"unsalted butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":4,"unit":"","name":"eggs"},{"amount":1,"unit":"tsp","name":"vanilla extract"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":125,"unit":"ml","name":"milk"},{"amount":25,"unit":"g","name":"cocoa powder mixed with 2 tbsp milk"},{"amount":0.25,"unit":"tsp","name":"pink food colouring (optional)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Make the vanilla butter cake batter: cream butter, sugar and vanilla; add eggs; fold in flour and milk.","Divide batter into three bowls: leave one plain, tint one pink, mix cocoa paste into the third.","Dollop alternating spoonfuls into the pans and swirl once with a skewer.","Bake 30–35 minutes until a skewer comes out clean."],"notes":""},{"id":"bake-spiced-apple-cake","title":"Spiced Apple Cake","category":"Cakes","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"unsalted butter, softened"},{"amount":200,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":2,"unit":"tsp","name":"ground cinnamon"},{"amount":0.5,"unit":"tsp","name":"ground nutmeg"},{"amount":300,"unit":"g","name":"apple, peeled and diced (about 2)"},{"amount":60,"unit":"ml","name":"milk"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar; beat in eggs one at a time.","Fold in flour and spices alternately with milk, then the diced apple.","Divide between pans and bake 35–40 minutes.","Dust with cinnamon sugar while warm."],"notes":""},{"id":"bake-sticky-date-cake-with-butterscotch-sauce","title":"Sticky Date Cake with Butterscotch Sauce","category":"Cakes","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":350,"unit":"g","name":"pitted dates, chopped"},{"amount":375,"unit":"ml","name":"boiling water"},{"amount":1.5,"unit":"tsp","name":"bicarbonate of soda"},{"amount":125,"unit":"g","name":"unsalted butter, softened"},{"amount":200,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":200,"unit":"g","name":"brown sugar (sauce)"},{"amount":300,"unit":"ml","name":"thickened cream (sauce)"},{"amount":100,"unit":"g","name":"butter (sauce)"}],"steps":["Soak dates in boiling water with bicarb for 10 minutes, then mash roughly.","Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar; add eggs one at a time. Fold in flour and the date mixture.","Bake 35–40 minutes until a skewer comes out clean.","For the sauce, stir brown sugar, cream and butter over low heat until glossy; simmer 3 minutes. Pour over warm cake."],"notes":""},{"id":"bake-pistachio-cake","title":"Pistachio Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"unsalted butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":4,"unit":"","name":"eggs"},{"amount":150,"unit":"g","name":"pistachios, finely ground"},{"amount":200,"unit":"g","name":"self-raising flour"},{"amount":100,"unit":"ml","name":"milk"},{"amount":0.5,"unit":"tsp","name":"ground cardamom (optional)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar; add eggs one at a time.","Fold in ground pistachios, flour and cardamom alternately with milk.","Divide between pans and bake 30–35 minutes.","Finish with a light lemon glaze and crushed pistachios."],"notes":""},{"id":"bake-hummingbird-cake","title":"Hummingbird Cake","category":"Cakes","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":250,"unit":"ml","name":"vegetable oil"},{"amount":220,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"plain flour"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"},{"amount":1,"unit":"tsp","name":"ground cinnamon"},{"amount":250,"unit":"g","name":"crushed pineapple, drained"},{"amount":300,"unit":"g","name":"ripe banana, mashed"},{"amount":60,"unit":"g","name":"pecans, chopped"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Whisk oil, sugar and eggs together.","Fold in flour, bicarb and cinnamon, then pineapple, banana and pecans.","Divide between pans and bake 35–40 minutes.","Cool completely and ice with cream cheese frosting."],"notes":""},{"id":"bake-lime-coconut-cake","title":"Lime Coconut Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":125,"unit":"g","name":"unsalted butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":2,"unit":"tbsp","name":"lime zest (about 3 limes)"},{"amount":2,"unit":"","name":"eggs"},{"amount":85,"unit":"g","name":"desiccated coconut"},{"amount":260,"unit":"g","name":"self-raising flour"},{"amount":200,"unit":"ml","name":"coconut milk"},{"amount":60,"unit":"ml","name":"lime juice"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter, sugar and zest; beat in eggs one at a time.","Fold in coconut, then flour alternately with combined coconut milk and lime juice.","Divide between pans and bake 30–35 minutes.","Drizzle with lime glaze while warm."],"notes":""},{"id":"bake-earl-grey-cake","title":"Earl Grey Cake","category":"Cakes","time":"30–35 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":185,"unit":"ml","name":"milk"},{"amount":4,"unit":"","name":"Earl Grey tea bags"},{"amount":200,"unit":"g","name":"unsalted butter, softened"},{"amount":220,"unit":"g","name":"caster sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":1,"unit":"tsp","name":"vanilla extract"}],"steps":["Heat milk until steaming, add tea bags and steep 15 minutes. Squeeze out and cool.","Preheat oven to 160°C fan-forced. Grease and line the pans.","Cream butter and sugar; add eggs one at a time, then vanilla.","Fold in flour alternately with the tea-infused milk.","Bake 30–35 minutes. Pairs beautifully with honey or lemon buttercream."],"notes":""},{"id":"bake-chocolate-beetroot-cake","title":"Chocolate Beetroot Cake","category":"Cakes","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":20,"quantity":2},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"cooked beetroot, puréed"},{"amount":150,"unit":"g","name":"dark chocolate, melted"},{"amount":200,"unit":"ml","name":"vegetable oil"},{"amount":220,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":200,"unit":"g","name":"self-raising flour"},{"amount":50,"unit":"g","name":"cocoa powder"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line the pans.","Whisk oil, sugar and eggs, then stir in beetroot purée and melted chocolate.","Fold in flour and cocoa until just combined.","Divide between pans and bake 35–40 minutes.","Incredibly moist — finish with dark chocolate ganache."],"notes":""},{"id":"bake-chocolate-weet-bix-slice","title":"Chocolate Weet-Bix Slice","category":"Slices","time":"15–18 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":60,"unit":"g","name":"Weet-Bix, crushed (about 4)"},{"amount":150,"unit":"g","name":"self-raising flour"},{"amount":85,"unit":"g","name":"desiccated coconut"},{"amount":165,"unit":"g","name":"brown sugar"},{"amount":30,"unit":"g","name":"cocoa powder"},{"amount":185,"unit":"g","name":"butter, melted"},{"amount":240,"unit":"g","name":"icing sugar (icing)"},{"amount":30,"unit":"g","name":"cocoa powder (icing)"},{"amount":20,"unit":"g","name":"butter, softened (icing)"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 20 × 30 cm slice tin.","Combine crushed Weet-Bix, flour, coconut, sugar and cocoa; stir in melted butter.","Press firmly into the tin and bake 15–18 minutes.","Beat icing ingredients with 2–3 tbsp hot water until spreadable; ice while the slice is still warm.","Sprinkle with extra coconut and cut once cool."],"notes":""},{"id":"bake-vanilla-slice","title":"Vanilla Slice","category":"Slices","time":"Set 4 hours","temp":"200°C fan-forced (pastry)","scaling":"pan","basePan":{"shape":"square","side":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":2,"unit":"","name":"sheets frozen puff pastry, thawed"},{"amount":1000,"unit":"ml","name":"milk"},{"amount":140,"unit":"g","name":"caster sugar"},{"amount":80,"unit":"g","name":"cornflour"},{"amount":60,"unit":"g","name":"custard powder"},{"amount":60,"unit":"g","name":"butter"},{"amount":2,"unit":"","name":"eggs yolks only"},{"amount":2,"unit":"tsp","name":"vanilla extract"},{"amount":240,"unit":"g","name":"icing sugar (passionfruit icing)"},{"amount":60,"unit":"g","name":"passionfruit pulp (icing)"}],"steps":["Bake pastry sheets between two trays at 200°C fan-forced for 15 minutes until crisp; trim to fit a 20 cm square tin.","Whisk sugar, cornflour and custard powder with a splash of the milk to a paste; heat remaining milk, then whisk everything over medium heat until very thick.","Beat in butter, yolks and vanilla off the heat.","Sandwich hot custard between the pastry sheets in the lined tin; press gently.","Refrigerate 4 hours; ice with passionfruit icing and cut with a serrated knife."],"notes":""},{"id":"bake-apricot-slice-no-bake-","title":"Apricot Slice (No-Bake)","category":"Slices","time":"Set 2 hours","temp":"No bake — refrigerate","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"dried apricots, finely chopped"},{"amount":250,"unit":"g","name":"Marie biscuits, crushed"},{"amount":95,"unit":"g","name":"desiccated coconut"},{"amount":395,"unit":"g","name":"sweetened condensed milk (1 tin)"},{"amount":60,"unit":"g","name":"butter, melted"},{"amount":40,"unit":"g","name":"extra coconut, for topping"}],"steps":["Line the tin.","Combine apricots, biscuit crumbs and coconut.","Stir in condensed milk and melted butter until everything holds together.","Press firmly into the tin, scatter with extra coconut and press lightly.","Refrigerate 2 hours, then slice into bars."],"notes":""},{"id":"bake-rocky-road-slice","title":"Rocky Road Slice","category":"Slices","time":"Set 1–2 hours","temp":"No bake — refrigerate","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":400,"unit":"g","name":"milk chocolate"},{"amount":100,"unit":"g","name":"dark chocolate"},{"amount":200,"unit":"g","name":"marshmallows, halved"},{"amount":150,"unit":"g","name":"raspberry lollies, halved"},{"amount":100,"unit":"g","name":"salted peanuts"},{"amount":45,"unit":"g","name":"shredded coconut"}],"steps":["Line the tin.","Melt both chocolates together gently; cool 5 minutes.","Toss marshmallows, raspberries, peanuts and coconut in the tin.","Pour over the chocolate and nudge everything so it's coated.","Refrigerate until set, then cut into generous chunks."],"notes":""},{"id":"bake-millionaire-s-shortbread","title":"Millionaire's Shortbread","category":"Slices","time":"Base 20 min + set","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"plain flour"},{"amount":80,"unit":"g","name":"caster sugar"},{"amount":175,"unit":"g","name":"butter, softened (base)"},{"amount":395,"unit":"g","name":"sweetened condensed milk (1 tin)"},{"amount":100,"unit":"g","name":"butter (caramel)"},{"amount":80,"unit":"g","name":"brown sugar"},{"amount":60,"unit":"g","name":"golden syrup"},{"amount":200,"unit":"g","name":"milk chocolate (topping)"}],"steps":["Preheat oven to 160°C fan-forced. Line the tin.","Rub flour, sugar and butter to a dough; press into the tin and bake 20 minutes until pale gold.","Stir condensed milk, butter, brown sugar and syrup over low heat 10–12 minutes until thick and caramel-coloured; pour over the base.","Chill until the caramel is firm.","Spread with melted chocolate; refrigerate and cut with a hot knife."],"notes":""},{"id":"bake-honey-joy-slice","title":"Honey Joy Slice","category":"Slices","time":"10 min","temp":"150°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":120,"unit":"g","name":"butter"},{"amount":90,"unit":"g","name":"honey"},{"amount":55,"unit":"g","name":"caster sugar"},{"amount":160,"unit":"g","name":"cornflakes"}],"steps":["Preheat oven to 150°C fan-forced. Line the tin.","Melt butter, honey and sugar until frothy.","Toss through cornflakes until well coated.","Press lightly into the tin — don't crush the flakes.","Bake 10 minutes, cool completely, then break into rough bars."],"notes":""},{"id":"bake-gingerbread-biscuits","title":"Gingerbread Biscuits","category":"Biscuits & Cookies","time":"10–12 min","temp":"160°C fan-forced","scaling":"batch","yield":"Makes about 30","baseServings":1,"ingredients":[{"amount":125,"unit":"g","name":"butter, softened"},{"amount":100,"unit":"g","name":"brown sugar"},{"amount":125,"unit":"g","name":"golden syrup"},{"amount":1,"unit":"","name":"eggs"},{"amount":375,"unit":"g","name":"plain flour"},{"amount":1,"unit":"tbsp","name":"ground ginger"},{"amount":1,"unit":"tsp","name":"mixed spice"},{"amount":1,"unit":"tsp","name":"bicarbonate of soda"}],"steps":["Beat butter, sugar and golden syrup until pale; beat in the egg.","Fold in flour, spices and bicarb to form a firm dough. Chill 30 minutes.","Preheat oven to 160°C fan-forced. Roll out to 4 mm and cut shapes.","Bake 10–12 minutes until just golden at the edges.","Cool on trays; decorate with royal icing if you like."],"notes":""},{"id":"bake-yo-yos","title":"Yo-Yos","category":"Biscuits & Cookies","time":"15 min","temp":"150°C fan-forced","scaling":"batch","yield":"Makes about 15 filled","baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"butter, softened"},{"amount":80,"unit":"g","name":"icing sugar"},{"amount":210,"unit":"g","name":"plain flour"},{"amount":90,"unit":"g","name":"custard powder"},{"amount":60,"unit":"g","name":"butter, softened (filling)"},{"amount":120,"unit":"g","name":"icing sugar (filling)"},{"amount":1,"unit":"tbsp","name":"custard powder (filling)"},{"amount":2,"unit":"tsp","name":"lemon juice (filling)"}],"steps":["Preheat oven to 150°C fan-forced. Line two trays.","Beat butter and icing sugar until pale and creamy.","Fold in flour and custard powder; roll into balls and flatten lightly with a fork.","Bake 15 minutes until set but not coloured. Cool completely.","Beat filling until fluffy and sandwich pairs together."],"notes":""},{"id":"bake-chocolate-macarons","title":"Chocolate Macarons","category":"Biscuits & Cookies","time":"15–18 min + resting","temp":"140°C fan-forced","scaling":"batch","yield":"Makes about 20 filled","baseServings":1,"ingredients":[{"amount":100,"unit":"g","name":"egg whites (about 3), room temperature"},{"amount":50,"unit":"g","name":"caster sugar"},{"amount":110,"unit":"g","name":"almond meal"},{"amount":200,"unit":"g","name":"icing sugar"},{"amount":1,"unit":"tbsp","name":"cocoa powder"},{"amount":100,"unit":"g","name":"dark chocolate (ganache)"},{"amount":100,"unit":"ml","name":"thickened cream (ganache)"}],"steps":["Blitz and sift almond meal, icing sugar and cocoa together twice.","Whisk egg whites to soft peaks, gradually adding caster sugar until glossy and stiff.","Fold in the dry mix until the batter flows like slow lava; pipe 4 cm rounds onto lined trays.","Rest 30–45 minutes until a skin forms, then bake at 140°C fan-forced 15–18 minutes.","Heat cream, pour over chocolate, stir until smooth; cool until thick and sandwich the shells."],"notes":""},{"id":"bake-oat-sultana-cookies","title":"Oat & Sultana Cookies","category":"Biscuits & Cookies","time":"12–14 min","temp":"160°C fan-forced","scaling":"batch","yield":"Makes about 22","baseServings":1,"ingredients":[{"amount":125,"unit":"g","name":"butter, softened"},{"amount":100,"unit":"g","name":"brown sugar"},{"amount":55,"unit":"g","name":"caster sugar"},{"amount":1,"unit":"","name":"eggs"},{"amount":135,"unit":"g","name":"plain flour"},{"amount":0.5,"unit":"tsp","name":"bicarbonate of soda"},{"amount":1,"unit":"tsp","name":"ground cinnamon"},{"amount":135,"unit":"g","name":"rolled oats"},{"amount":120,"unit":"g","name":"sultanas"}],"steps":["Preheat oven to 160°C fan-forced. Line two trays.","Cream butter and both sugars; beat in the egg.","Fold in flour, bicarb and cinnamon, then oats and sultanas.","Roll tablespoons of dough and flatten slightly, 5 cm apart.","Bake 12–14 minutes until golden. Cool on trays."],"notes":""},{"id":"bake-lemon-meringue-tart","title":"Lemon Meringue Tart","category":"Tarts & Pastries","time":"Pastry 30 min + 10 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":24,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"plain flour (pastry)"},{"amount":100,"unit":"g","name":"butter, chilled (pastry)"},{"amount":55,"unit":"g","name":"caster sugar (pastry)"},{"amount":1,"unit":"","name":"eggs yolk only (pastry)"},{"amount":80,"unit":"g","name":"cornflour"},{"amount":250,"unit":"ml","name":"water"},{"amount":125,"unit":"ml","name":"lemon juice"},{"amount":2,"unit":"tbsp","name":"lemon zest"},{"amount":165,"unit":"g","name":"caster sugar (filling)"},{"amount":3,"unit":"","name":"eggs yolks only (filling)"},{"amount":60,"unit":"g","name":"butter (filling)"},{"amount":3,"unit":"","name":"eggs whites only (meringue)"},{"amount":165,"unit":"g","name":"caster sugar (meringue)"}],"steps":["Blitz pastry ingredients with 2 tbsp cold water to a dough; chill 30 minutes, roll out and line a 24 cm tart tin. Blind bake at 160°C fan-forced 20 minutes, then 10 uncovered.","Whisk cornflour, water, lemon juice, zest and sugar over medium heat until very thick; beat in yolks and butter. Pour into the shell.","Whisk egg whites to soft peaks, gradually add sugar until glossy.","Pile meringue over the filling, sealing to the pastry edge, and swirl.","Bake 8–10 minutes until the peaks are golden. Cool before slicing."],"notes":""},{"id":"bake-portuguese-egg-tarts","title":"Portuguese Egg Tarts","category":"Tarts & Pastries","time":"20–25 min","temp":"200°C fan-forced","scaling":"batch","yield":"Makes 12","baseServings":1,"ingredients":[{"amount":2,"unit":"","name":"sheets frozen puff pastry, thawed"},{"amount":300,"unit":"ml","name":"thickened cream"},{"amount":110,"unit":"g","name":"caster sugar"},{"amount":5,"unit":"","name":"eggs yolks only"},{"amount":1,"unit":"tbsp","name":"cornflour"},{"amount":1,"unit":"tsp","name":"vanilla extract"},{"amount":1,"unit":"tsp","name":"lemon zest"}],"steps":["Preheat oven to 200°C fan-forced. Grease a 12-hole muffin tin.","Roll each pastry sheet into a log, cut into 6 rounds each, and press into the holes to form cups.","Whisk cream, sugar, yolks, cornflour, vanilla and zest over low heat until slightly thickened.","Fill the pastry cups three-quarters full.","Bake 20–25 minutes until blistered and golden on top. Best warm."],"notes":""},{"id":"bake-fresh-fruit-tart","title":"Fresh Fruit Tart","category":"Tarts & Pastries","time":"Pastry 30 min, assemble cold","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":24,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"plain flour (pastry)"},{"amount":100,"unit":"g","name":"butter, chilled (pastry)"},{"amount":55,"unit":"g","name":"icing sugar (pastry)"},{"amount":1,"unit":"","name":"eggs yolk only (pastry)"},{"amount":500,"unit":"ml","name":"milk"},{"amount":5,"unit":"","name":"eggs yolks only (custard)"},{"amount":110,"unit":"g","name":"caster sugar"},{"amount":40,"unit":"g","name":"cornflour"},{"amount":2,"unit":"tsp","name":"vanilla extract"},{"amount":400,"unit":"g","name":"mixed fresh fruit (berries, kiwi, stone fruit)"},{"amount":60,"unit":"g","name":"apricot jam, warmed (glaze)"}],"steps":["Make pastry with 2 tbsp cold water; chill, roll, line a 24 cm tart tin and blind bake at 160°C fan-forced until golden. Cool.","Whisk yolks, sugar and cornflour; heat milk and vanilla, whisk into the yolks, then stir over medium heat until thick. Cover and chill.","Beat the cold crème pâtissière until smooth and spread into the shell.","Arrange fruit over the top.","Brush with warmed, sieved apricot jam to glaze. Serve the day it's made."],"notes":""},{"id":"bake-chocolate-ganache-tart","title":"Chocolate Ganache Tart","category":"Tarts & Pastries","time":"Pastry 30 min + set 2 hours","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":24,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"plain flour (pastry)"},{"amount":30,"unit":"g","name":"cocoa powder (pastry)"},{"amount":100,"unit":"g","name":"butter, chilled (pastry)"},{"amount":55,"unit":"g","name":"icing sugar (pastry)"},{"amount":1,"unit":"","name":"eggs yolk only (pastry)"},{"amount":300,"unit":"g","name":"dark chocolate, chopped"},{"amount":300,"unit":"ml","name":"thickened cream"},{"amount":30,"unit":"g","name":"butter (ganache)"},{"amount":1,"unit":"tsp","name":"sea salt flakes"}],"steps":["Blitz pastry ingredients with 2 tbsp cold water; chill 30 minutes, roll out and line a 24 cm tart tin.","Blind bake at 160°C fan-forced 20 minutes, then 8 minutes uncovered. Cool.","Heat cream to just below a simmer; pour over the chocolate and stand 2 minutes.","Stir until glossy, then stir in butter. Pour into the shell.","Refrigerate 2 hours; scatter salt flakes and serve in thin slices."],"notes":""},{"id":"bake-pear-frangipane-tart","title":"Pear Frangipane Tart","category":"Tarts & Pastries","time":"35–40 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":24,"quantity":1},"baseServings":1,"ingredients":[{"amount":200,"unit":"g","name":"plain flour (pastry)"},{"amount":100,"unit":"g","name":"butter, chilled (pastry)"},{"amount":55,"unit":"g","name":"icing sugar (pastry)"},{"amount":1,"unit":"","name":"eggs yolk only (pastry)"},{"amount":150,"unit":"g","name":"butter, softened (frangipane)"},{"amount":150,"unit":"g","name":"caster sugar"},{"amount":150,"unit":"g","name":"almond meal"},{"amount":2,"unit":"","name":"eggs (frangipane)"},{"amount":30,"unit":"g","name":"plain flour (frangipane)"},{"amount":2,"unit":"","name":"ripe pears, thinly sliced"},{"amount":20,"unit":"g","name":"flaked almonds"}],"steps":["Make pastry with 2 tbsp cold water; chill, roll and line a 24 cm tart tin. Blind bake at 160°C fan-forced 15 minutes.","Beat butter and sugar; beat in eggs, then fold in almond meal and flour.","Spread frangipane into the shell and fan the pear slices over the top.","Scatter with flaked almonds.","Bake 35–40 minutes until golden and set. Glaze with warmed apricot jam."],"notes":""},{"id":"bake-rough-puff-pastry-for-sausage-rolls-pies-","title":"Rough Puff Pastry (for Sausage Rolls & Pies)","category":"Tarts & Pastries","time":"1 hr incl. resting","temp":"200°C fan-forced (to bake)","scaling":"batch","yield":"Makes about 700 g pastry","baseServings":1,"ingredients":[{"amount":300,"unit":"g","name":"plain flour"},{"amount":250,"unit":"g","name":"butter, very cold, cubed"},{"amount":0.5,"unit":"tsp","name":"salt"},{"amount":150,"unit":"ml","name":"iced water"}],"steps":["Toss flour, salt and butter cubes — leave the butter in visible chunks.","Add iced water and bring together into a shaggy dough. Shape into a rectangle.","Roll into a long rectangle, fold in thirds like a letter. Turn 90° and repeat.","Chill 30 minutes, then do two more roll-and-folds.","Rest 30 minutes before using. Bake filled pastries at 200°C fan-forced until deep golden."],"notes":""},{"id":"bake-profiteroles-choux-pastry-","title":"Profiteroles (Choux Pastry)","category":"Tarts & Pastries","time":"25–30 min","temp":"180°C fan-forced","scaling":"batch","yield":"Makes about 24","baseServings":1,"ingredients":[{"amount":100,"unit":"g","name":"butter"},{"amount":250,"unit":"ml","name":"water"},{"amount":0.25,"unit":"tsp","name":"salt"},{"amount":150,"unit":"g","name":"plain flour"},{"amount":4,"unit":"","name":"eggs"},{"amount":300,"unit":"ml","name":"thickened cream, whipped (filling)"},{"amount":100,"unit":"g","name":"dark chocolate (sauce)"},{"amount":100,"unit":"ml","name":"cream, extra (sauce)"}],"steps":["Preheat oven to 180°C fan-forced. Line two trays.","Boil butter, water and salt; dump in flour and beat over heat until the dough leaves the sides of the pan. Cool 5 minutes.","Beat in eggs one at a time until glossy and pipeable.","Pipe walnut-sized rounds; bake 25–30 minutes until puffed and deep golden. Pierce each and cool.","Fill with whipped cream and pour over warm chocolate sauce (melt chocolate with extra cream)."],"notes":""},{"id":"bake-zucchini-walnut-loaf","title":"Zucchini Walnut Loaf","category":"Loaves, Muffins & Other","time":"55 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":21,"width":11,"quantity":1},"baseServings":1,"ingredients":[{"amount":300,"unit":"g","name":"zucchini, grated (about 2)"},{"amount":250,"unit":"ml","name":"vegetable oil"},{"amount":200,"unit":"g","name":"brown sugar"},{"amount":3,"unit":"","name":"eggs"},{"amount":300,"unit":"g","name":"self-raising flour"},{"amount":1,"unit":"tsp","name":"ground cinnamon"},{"amount":100,"unit":"g","name":"walnuts, chopped"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 21 × 11 cm loaf tin.","Squeeze excess moisture from the zucchini.","Whisk oil, sugar and eggs; stir in zucchini.","Fold in flour, cinnamon and walnuts; pour into the tin.","Bake 55 minutes until a skewer comes out clean."],"notes":""},{"id":"bake-white-choc-macadamia-blondies","title":"White Choc Macadamia Blondies","category":"Loaves, Muffins & Other","time":"30 min","temp":"160°C fan-forced","scaling":"pan","basePan":{"shape":"square","side":20,"quantity":1},"baseServings":1,"ingredients":[{"amount":180,"unit":"g","name":"butter, melted"},{"amount":220,"unit":"g","name":"brown sugar"},{"amount":2,"unit":"","name":"eggs"},{"amount":2,"unit":"tsp","name":"vanilla extract"},{"amount":220,"unit":"g","name":"plain flour"},{"amount":0.5,"unit":"tsp","name":"baking powder"},{"amount":180,"unit":"g","name":"white chocolate, chopped"},{"amount":100,"unit":"g","name":"macadamias, roughly chopped"}],"steps":["Preheat oven to 160°C fan-forced. Grease and line a 20 cm square tin.","Whisk melted butter and sugar; whisk in eggs and vanilla.","Fold in flour and baking powder, then chocolate and macadamias.","Spread into the tin.","Bake 30 minutes until golden but still soft in the centre. Cool before cutting."],"notes":""},{"id":"bake-raspberry-friands","title":"Raspberry Friands","category":"Loaves, Muffins & Other","time":"20 min","temp":"180°C fan-forced","scaling":"batch","yield":"Makes 12","baseServings":1,"ingredients":[{"amount":210,"unit":"g","name":"egg whites (about 6)"},{"amount":185,"unit":"g","name":"butter, melted and cooled"},{"amount":240,"unit":"g","name":"icing sugar"},{"amount":120,"unit":"g","name":"almond meal"},{"amount":75,"unit":"g","name":"plain flour"},{"amount":150,"unit":"g","name":"raspberries (fresh or frozen)"}],"steps":["Preheat oven to 180°C fan-forced. Grease a 12-hole friand or muffin tin.","Whisk egg whites with a fork until frothy — no need for peaks.","Stir in butter, sifted icing sugar, almond meal and flour until smooth.","Divide between holes and press 2–3 raspberries into each.","Bake 20 minutes until golden and springy. Dust with icing sugar."],"notes":""},{"id":"bake-white-sandwich-loaf","title":"White Sandwich Loaf","category":"Breads","time":"30–35 min + proving","temp":"180°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":22,"width":12,"quantity":1},"baseServings":1,"ingredients":[{"amount":500,"unit":"g","name":"baker's (bread) flour"},{"amount":7,"unit":"g","name":"instant dried yeast (1 sachet)"},{"amount":10,"unit":"g","name":"salt"},{"amount":20,"unit":"g","name":"caster sugar"},{"amount":30,"unit":"g","name":"butter, softened"},{"amount":300,"unit":"ml","name":"warm water"}],"steps":["Mix flour, yeast, salt and sugar. Add water and butter; knead 10 minutes until smooth and elastic (windowpane test).","Cover and prove in a warm spot about 1 hour until doubled.","Knock back, shape into a log and place in a greased 22 × 12 cm loaf tin. Prove 40 minutes until risen 2 cm above the rim.","Preheat oven to 180°C fan-forced.","Bake 30–35 minutes until deep golden and hollow-sounding when tapped on the base. Cool on a rack before slicing."],"notes":""},{"id":"bake-wholemeal-brown-loaf","title":"Wholemeal (Brown) Loaf","category":"Breads","time":"35 min + proving","temp":"180°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":22,"width":12,"quantity":1},"baseServings":1,"ingredients":[{"amount":300,"unit":"g","name":"wholemeal flour"},{"amount":200,"unit":"g","name":"baker's (bread) flour"},{"amount":7,"unit":"g","name":"instant dried yeast"},{"amount":10,"unit":"g","name":"salt"},{"amount":20,"unit":"g","name":"honey"},{"amount":30,"unit":"ml","name":"olive oil"},{"amount":320,"unit":"ml","name":"warm water"}],"steps":["Mix both flours, yeast and salt. Add honey, oil and water; knead 10 minutes — wholemeal dough is slightly tackier, resist adding flour.","Cover and prove 1 hour until doubled.","Knock back, shape and place in a greased 22 × 12 cm loaf tin. Prove 40 minutes.","Preheat oven to 180°C fan-forced.","Bake 35 minutes until dark golden and hollow when tapped. Cool fully — wholemeal gums if cut warm."],"notes":""},{"id":"bake-seeded-multigrain-loaf","title":"Seeded Multigrain Loaf","category":"Breads","time":"35 min + proving","temp":"180°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":22,"width":12,"quantity":1},"baseServings":1,"ingredients":[{"amount":250,"unit":"g","name":"wholemeal flour"},{"amount":250,"unit":"g","name":"baker's (bread) flour"},{"amount":60,"unit":"g","name":"mixed seeds (pepitas, sunflower, linseed)"},{"amount":20,"unit":"g","name":"rolled oats (topping)"},{"amount":7,"unit":"g","name":"instant dried yeast"},{"amount":10,"unit":"g","name":"salt"},{"amount":20,"unit":"g","name":"honey"},{"amount":30,"unit":"ml","name":"olive oil"},{"amount":330,"unit":"ml","name":"warm water"}],"steps":["Mix flours, seeds, yeast and salt. Add honey, oil and water; knead 10 minutes.","Cover and prove 1 hour until doubled.","Shape into a log, brush the top with water and roll in oats. Place in a greased 22 × 12 cm tin; prove 40 minutes.","Preheat oven to 180°C fan-forced.","Bake 35 minutes until deep golden. Cool on a rack — brilliant toasted."],"notes":""},{"id":"bake-olive-loaf","title":"Olive Loaf","category":"Breads","time":"35 min + proving","temp":"200°C fan-forced","scaling":"batch","yield":"Makes 1 rustic round","baseServings":1,"ingredients":[{"amount":500,"unit":"g","name":"baker's (bread) flour"},{"amount":7,"unit":"g","name":"instant dried yeast"},{"amount":10,"unit":"g","name":"salt"},{"amount":320,"unit":"ml","name":"warm water"},{"amount":30,"unit":"ml","name":"olive oil"},{"amount":160,"unit":"g","name":"pitted kalamata olives, halved and patted dry"},{"amount":1,"unit":"tsp","name":"dried oregano"}],"steps":["Mix flour, yeast, salt and oregano. Add water and oil; knead 10 minutes until elastic.","Flatten the dough, scatter over the olives and knead gently 1 minute to distribute without mashing them.","Cover and prove 1 hour until doubled. Shape into a round, place on a lined tray, prove 45 minutes.","Preheat oven to 200°C fan-forced. Slash the top and dust lightly with flour.","Bake 35 minutes until deep golden and hollow when tapped. Cool before slicing."],"notes":""},{"id":"bake-rosemary-thyme-focaccia","title":"Rosemary & Thyme Focaccia","category":"Breads","time":"22–25 min + proving","temp":"200°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":30,"width":20,"quantity":1,"depth":3},"baseServings":1,"ingredients":[{"amount":500,"unit":"g","name":"baker's (bread) flour"},{"amount":7,"unit":"g","name":"instant dried yeast"},{"amount":10,"unit":"g","name":"salt"},{"amount":400,"unit":"ml","name":"warm water"},{"amount":60,"unit":"ml","name":"olive oil, plus extra for the tin"},{"amount":2,"unit":"tbsp","name":"rosemary leaves"},{"amount":1,"unit":"tbsp","name":"thyme leaves"},{"amount":1,"unit":"tsp","name":"sea salt flakes"}],"steps":["Mix flour, yeast and salt; add water and half the oil. The dough is wet — mix until shaggy, no kneading needed.","Cover and rest 20 minutes, then stretch-and-fold in the bowl. Prove 1 hour until puffy.","Tip into a generously oiled 20 × 30 cm tin, stretch to the corners, prove 30 minutes.","Preheat oven to 200°C fan-forced. Dimple deeply with oiled fingers, drizzle remaining oil, scatter herbs and salt flakes.","Bake 22–25 minutes until golden and crisp-edged. Best the day it's baked."],"notes":""},{"id":"bake-spinach-feta-swirl-loaf","title":"Spinach & Feta Swirl Loaf","category":"Breads","time":"35 min + proving","temp":"180°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":22,"width":12,"quantity":1},"baseServings":1,"ingredients":[{"amount":500,"unit":"g","name":"baker's (bread) flour"},{"amount":7,"unit":"g","name":"instant dried yeast"},{"amount":10,"unit":"g","name":"salt"},{"amount":300,"unit":"ml","name":"warm water"},{"amount":30,"unit":"ml","name":"olive oil"},{"amount":150,"unit":"g","name":"baby spinach, wilted and squeezed very dry"},{"amount":150,"unit":"g","name":"feta, crumbled"},{"amount":1,"unit":"","name":"garlic clove, crushed"}],"steps":["Make the dough: mix flour, yeast and salt, add water and oil, knead 10 minutes. Prove 1 hour until doubled.","Mix spinach, feta and garlic — the spinach must be squeezed properly dry or the swirl goes soggy.","Roll the dough to a 25 × 35 cm rectangle, spread with filling, and roll up from the short side.","Place seam-down in a greased 22 × 12 cm loaf tin. Prove 40 minutes. Preheat oven to 180°C fan-forced.","Bake 35 minutes until golden — cover with foil if browning fast. Cool 20 minutes before slicing to keep the swirl intact."],"notes":""},{"id":"bake-bacon-cheese-loaf","title":"Bacon & Cheese Loaf","category":"Breads","time":"35 min + proving","temp":"180°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":22,"width":12,"quantity":1},"baseServings":1,"ingredients":[{"amount":500,"unit":"g","name":"baker's (bread) flour"},{"amount":7,"unit":"g","name":"instant dried yeast"},{"amount":8,"unit":"g","name":"salt"},{"amount":300,"unit":"ml","name":"warm water"},{"amount":30,"unit":"g","name":"butter, softened"},{"amount":150,"unit":"g","name":"bacon, diced and cooked crisp"},{"amount":120,"unit":"g","name":"cheddar, grated"},{"amount":40,"unit":"g","name":"cheddar, extra (topping)"}],"steps":["Mix flour, yeast and salt; add water and butter, knead 10 minutes.","Flatten the dough and knead through the cooled bacon and cheddar until evenly flecked.","Prove 1 hour until doubled. Shape and place in a greased 22 × 12 cm loaf tin; prove 40 minutes.","Preheat oven to 180°C fan-forced. Scatter the extra cheddar over the top.","Bake 35 minutes until burnished and hollow when tapped. Outstanding toasted with butter."],"notes":""},{"id":"bake-classic-sourdough-loaf","title":"Classic Sourdough Loaf","category":"Breads","time":"45 min + overnight prove","temp":"230°C fan-forced (Dutch oven)","scaling":"batch","yield":"Makes 1 loaf","baseServings":1,"ingredients":[{"amount":500,"unit":"g","name":"baker's (bread) flour"},{"amount":100,"unit":"g","name":"active sourdough starter (fed, doubled)"},{"amount":10,"unit":"g","name":"salt"},{"amount":350,"unit":"ml","name":"water"}],"steps":["Mix flour and water; rest 30 minutes (autolyse). Add starter and salt, and work in by squeezing through the dough.","Bulk ferment 4–5 hours at room temp, with a stretch-and-fold every 45 minutes for the first 3 hours, until risen ~50% and jiggly.","Shape into a tight round, place seam-up in a floured banneton, and cold-prove in the fridge overnight (8–12 hours).","Preheat oven to 230°C fan-forced with a lidded Dutch oven inside for 45 minutes.","Turn the loaf into the pot, score, bake 20 minutes lid on, then 20–25 lid off until deep mahogany. Cool at least 1 hour — no exceptions."],"notes":""},{"id":"bake-cinnamon-raisin-loaf","title":"Cinnamon Raisin Loaf","category":"Breads","time":"35 min + proving","temp":"170°C fan-forced","scaling":"pan","basePan":{"shape":"rectangle","length":22,"width":12,"quantity":1},"baseServings":1,"ingredients":[{"amount":500,"unit":"g","name":"baker's (bread) flour"},{"amount":7,"unit":"g","name":"instant dried yeast"},{"amount":8,"unit":"g","name":"salt"},{"amount":50,"unit":"g","name":"caster sugar"},{"amount":30,"unit":"g","name":"butter, softened"},{"amount":280,"unit":"ml","name":"warm milk"},{"amount":150,"unit":"g","name":"raisins"},{"amount":40,"unit":"g","name":"caster sugar mixed with 2 tsp cinnamon (swirl)"}],"steps":["Mix flour, yeast, salt and sugar; add milk and butter, knead 10 minutes, then knead in the raisins.","Prove 1 hour until doubled.","Roll to a 22 cm-wide rectangle, scatter with cinnamon sugar, roll up and place seam-down in a greased 22 × 12 cm tin.","Prove 40 minutes. Preheat oven to 170°C fan-forced.","Bake 35 minutes, covering with foil if the top darkens early. Glaze with a little warmed honey while hot."],"notes":""},{"id":"bake-cheese-herb-damper","title":"Cheese & Herb Damper","category":"Breads","time":"30 min","temp":"190°C fan-forced","scaling":"batch","yield":"Makes 1 round","baseServings":1,"ingredients":[{"amount":450,"unit":"g","name":"self-raising flour"},{"amount":1,"unit":"tsp","name":"salt"},{"amount":60,"unit":"g","name":"butter, chilled"},{"amount":120,"unit":"g","name":"cheddar, grated"},{"amount":2,"unit":"tbsp","name":"chopped parsley and chives"},{"amount":280,"unit":"ml","name":"milk"}],"steps":["Preheat oven to 190°C fan-forced. No yeast, no proving — this is the quick one.","Rub butter into flour and salt; stir through cheese and herbs.","Add milk and mix with a knife to a soft dough; handle as little as possible.","Shape into an 18 cm round on a lined tray, cut a deep cross in the top, dust with flour.","Bake 30 minutes until golden and hollow-sounding. Eat warm with butter — damper waits for no one."],"notes":""},{"id":"bake-garlic-pull-apart-bread","title":"Garlic Pull-Apart Bread","category":"Breads","time":"30 min + proving","temp":"180°C fan-forced","scaling":"pan","basePan":{"shape":"round","diameter":22,"quantity":1},"baseServings":1,"ingredients":[{"amount":500,"unit":"g","name":"baker's (bread) flour"},{"amount":7,"unit":"g","name":"instant dried yeast"},{"amount":8,"unit":"g","name":"salt"},{"amount":300,"unit":"ml","name":"warm water"},{"amount":30,"unit":"g","name":"butter, softened"},{"amount":100,"unit":"g","name":"butter, melted (garlic butter)"},{"amount":4,"unit":"","name":"garlic cloves, crushed"},{"amount":2,"unit":"tbsp","name":"chopped parsley"}],"steps":["Make the dough: mix flour, yeast and salt, add water and butter, knead 10 minutes. Prove 1 hour.","Mix melted butter, garlic and parsley.","Divide the dough into ~24 balls, roll each in garlic butter, and pile into a greased 22 cm round tin.","Prove 30 minutes. Preheat oven to 180°C fan-forced.","Bake 30 minutes until golden. Pour over any leftover garlic butter and serve warm, torn not cut."],"notes":""},{"id":"bake-turkish-style-pide-bread","title":"Turkish-Style Pide Bread","category":"Breads","time":"15 min + proving","temp":"210°C fan-forced","scaling":"batch","yield":"Makes 2 flatbreads","baseServings":1,"ingredients":[{"amount":500,"unit":"g","name":"baker's (bread) flour"},{"amount":7,"unit":"g","name":"instant dried yeast"},{"amount":8,"unit":"g","name":"salt"},{"amount":1,"unit":"tsp","name":"caster sugar"},{"amount":350,"unit":"ml","name":"warm water"},{"amount":30,"unit":"ml","name":"olive oil"},{"amount":1,"unit":"","name":"eggs beaten with 1 tbsp milk (wash)"},{"amount":2,"unit":"tsp","name":"sesame and nigella seeds"}],"steps":["Mix flour, yeast, salt and sugar; add water and oil. The dough is soft — knead 8 minutes.","Prove 1 hour until doubled.","Divide in two; press each into an oval about 2 cm thick on lined trays. Prove 20 minutes.","Preheat oven to 210°C fan-forced. Dimple in the traditional diamond pattern with fingertips, brush with egg wash, scatter seeds.","Bake 15 minutes until puffed and golden. Best warm, torn at the table."],"notes":""}];

const SEED_RECIPES = [...STARTERS, ...DINNER_RECIPES, ...BAKE_RECIPES];

/* pan geometry (ported from the Bakehouse) */
const panArea = (p) => {
  const q = Number(p.quantity) || 1;
  if (p.shape === "round") return q * Math.PI * Math.pow(Number(p.diameter) / 2, 2);
  if (p.shape === "square") return q * Math.pow(Number(p.side), 2);
  if (p.shape === "bundt") return q * (Number(p.cups) * 250) / 4; // AU cup = 250 ml, ~4 cm batter depth equivalent
  if (p.shape === "dutch") return q * Number(p.litres) * 100; // capacity / ~10 cm effective depth = base area
  return q * Number(p.length) * Number(p.width); // rectangle and loaf
};
const panLabel = (p) => {
  if (!p) return "";
  const q = Number(p.quantity) || 1;
  const qs = q > 1 ? `${q} × ` : "";
  if (p.shape === "round") return `${qs}${p.diameter} cm round`;
  if (p.shape === "square") return `${qs}${p.side} cm square`;
  if (p.shape === "bundt") return `${qs}${p.cups}-cup bundt`;
  if (p.shape === "loaf") return `${qs}${p.length} × ${p.width} cm cast-iron loaf`;
  if (p.shape === "dutch") return `${qs}${p.litres} L dutch oven`;
  return `${qs}${p.length} × ${p.width} cm rectangle`;
};
const samePan = (a, b) => a && b && panLabel(a) === panLabel(b);

const BATCH_OPTIONS = [0.5, 1, 1.5, 2, 3];
const fmtFactor = (f) => (f === 0.5 ? "½" : f === 1.5 ? "1½" : String(Math.round(f * 100) / 100));
const scaleYield = (y, f) => {
  if (!y) return "";
  if (f === 1) return y;
  return y.replace(/\d+/g, (n) => String(Math.max(1, Math.round(parseInt(n, 10) * f))));
};
const scalingKind = (r) => r.scaling === "pan" || r.scaling === "batch" ? r.scaling : "serves";

/* skill levels — explicit on a recipe, otherwise worked out from the method */
const SKILL_LEVELS = ["Easy", "Moderate", "Challenging"];
const deriveSkill = (r) => {
  const text = ((r.steps || []).join(" ") + " " + (r.title || "")).toLowerCase();
  const hard = ["sourdough", "laminat", "choux", "macaron", "temper", "pavlova", "water bath", "soft-ball", "candy thermometer", "croissant"];
  const mid = ["yeast", "knead", "prove", "proof", "caramel", "custard", "ganache", "egg white", "meringue", "gelatine", "pastry", "bain-marie", "double boiler", "curd", "piping bag", "pipe the"];
  let level = 0;
  if (mid.some((k) => text.includes(k))) level = 1;
  if (hard.some((k) => text.includes(k))) level = 2;
  if ((r.steps || []).length >= 9 && level < 2) level += 1;
  return SKILL_LEVELS[level];
};
const skillOf = (r) => (r.skill && SKILL_LEVELS.includes(r.skill) ? r.skill : deriveSkill(r));
const skillColor = (lvl) => (lvl === "Easy" ? C.green : lvl === "Moderate" ? C.mustard : C.danger);

/* Australian cup-to-gram conversions (1 cup = 250 ml) — ported from the Bakehouse */
const CUP_TABLE = {
  "Plain / SR flour": 150, "Caster sugar": 220, "Brown sugar (packed)": 200, "Icing sugar": 160,
  "Butter": 230, "Cocoa powder": 100, "Rolled oats": 90, "Desiccated coconut": 85,
  "Almond meal": 100, "Honey / golden syrup": 350, "Milk / water (ml)": 250,
};
/* Australian standard measures: 250 ml cup, 20 ml tablespoon, 5 ml teaspoon */
const MEASURES = [
  ["1 cup", 250], ["3/4 cup", 187.5], ["2/3 cup", 167], ["1/2 cup", 125], ["1/3 cup", 83], ["1/4 cup", 62.5],
  ["1 tablespoon", 20], ["1/2 tablespoon", 10],
  ["1 teaspoon", 5], ["1/2 teaspoon", 2.5], ["1/4 teaspoon", 1.25], ["1/8 teaspoon", 0.6],
];

/* strip preparation detail so "butter, melted (base)" and "butter, softened" merge on the list */
const canonicalItemName = (name) => {
  let n = String(name).replace(/\([^)]*\)/g, "");
  n = n.split(",")[0];
  return n.replace(/\s+/g, " ").trim();
};

/* ---------- palette ---------- */

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const PALETTES = {
  olive: {
    label: "Olive Grove",
    light: { bg: "#F2F0E6", card: "#FCFBF5", ink: "#22301F", inkSoft: "#5A6653", green: "#33502F", greenDeep: "#243A21", mustard: "#C07A17", mustardSoft: "#F3E3C4", line: "#DCD9C8", danger: "#A93E2C", onPrimary: "#F4F2E4", onAccent: "#241A05", accentText: "#6E4A0C", noteText: "#5C3E0A", headMut: "#7A8470", faint: "#A5A899", disabledText: "#8B8875" },
    dark: { bg: "#161A13", card: "#1F251B", ink: "#E8EADD", inkSoft: "#A6AF9A", green: "#33502F", greenDeep: "#243A21", mustard: "#D89A3E", mustardSoft: "#453615", line: "#343C2E", danger: "#D0654F", onPrimary: "#F4F2E4", onAccent: "#241A05", accentText: "#E8C27C", noteText: "#E8C27C", headMut: "#8A957D", faint: "#6E7663", disabledText: "#7C8370" },
  },
  bluegum: {
    label: "Blue Gum",
    light: { bg: "#EEF1F2", card: "#FAFCFC", ink: "#1E2B31", inkSoft: "#56676F", green: "#2E4E57", greenDeep: "#203941", mustard: "#C2703D", mustardSoft: "#F2DFCE", line: "#D7DDDE", danger: "#A93E2C", onPrimary: "#EDF3F2", onAccent: "#2A1608", accentText: "#7A4620", noteText: "#6B3D1B", headMut: "#7C8B90", faint: "#A8B2B5", disabledText: "#8A9598" },
    dark: { bg: "#12181B", card: "#1B2429", ink: "#E4EBEC", inkSoft: "#9DAEB2", green: "#29444D", greenDeep: "#1C3238", mustard: "#D98C50", mustardSoft: "#4A2F17", line: "#2C383D", danger: "#D0654F", onPrimary: "#EDF3F2", onAccent: "#2A1608", accentText: "#EDBE8F", noteText: "#EDBE8F", headMut: "#7E9096", faint: "#64757B", disabledText: "#6E7F84" },
  },
  muskstick: {
    label: "Musk Stick",
    light: { bg: "#F8F0F3", card: "#FDF9FB", ink: "#34222B", inkSoft: "#755966", green: "#A83E68", greenDeep: "#8A3255", mustard: "#2E7F78", mustardSoft: "#CFE8E4", line: "#E6D8DE", danger: "#A93E2C", onPrimary: "#FDF4F8", onAccent: "#EAF7F5", accentText: "#1C5750", noteText: "#174A44", headMut: "#97808B", faint: "#B9A5B0", disabledText: "#98858F" },
    dark: { bg: "#1C1216", card: "#271A20", ink: "#F0E2E9", inkSoft: "#B79AA8", green: "#B14A74", greenDeep: "#8A3255", mustard: "#4FB3A9", mustardSoft: "#143D38", line: "#3A2A32", danger: "#D0654F", onPrimary: "#FDF4F8", onAccent: "#0E2B27", accentText: "#9ADCD3", noteText: "#9ADCD3", headMut: "#8F7A85", faint: "#6E5A64", disabledText: "#7E6A74" },
  },
  terracotta: {
    label: "Terracotta",
    light: { bg: "#F5EFE9", card: "#FCF8F4", ink: "#33251D", inkSoft: "#6F5B4E", green: "#9C4E2C", greenDeep: "#7C3D20", mustard: "#5F7A4E", mustardSoft: "#DDE8D3", line: "#E2D7CC", danger: "#A93E2C", onPrimary: "#FAF2EB", onAccent: "#F2F8EC", accentText: "#3D5330", noteText: "#33472A", headMut: "#91816F", faint: "#B3A392", disabledText: "#94846F" },
    dark: { bg: "#191210", card: "#241A16", ink: "#EFE4DB", inkSoft: "#B5A091", green: "#A65634", greenDeep: "#7C3D20", mustard: "#7FA267", mustardSoft: "#2A3A1F", line: "#37291F", danger: "#D0654F", onPrimary: "#FAF2EB", onAccent: "#16240E", accentText: "#B9D6A4", noteText: "#B9D6A4", headMut: "#8C7C6C", faint: "#6C5C4E", disabledText: "#7C6C5C" },
  },
  midnight: {
    label: "Midnight",
    light: { bg: "#EEF1F5", card: "#FAFBFD", ink: "#1C2634", inkSoft: "#55627A", green: "#23364E", greenDeep: "#16283C", mustard: "#B8862B", mustardSoft: "#F0E3C2", line: "#D8DDE4", danger: "#A93E2C", onPrimary: "#EFF3F8", onAccent: "#241A05", accentText: "#6E4E12", noteText: "#5C400C", headMut: "#7D8798", faint: "#A7B0BE", disabledText: "#8791A0" },
    dark: { bg: "#10151C", card: "#192129", ink: "#E3E9F0", inkSoft: "#9AA8BA", green: "#2A415E", greenDeep: "#1C2F45", mustard: "#D3A24A", mustardSoft: "#423412", line: "#2A3440", danger: "#D0654F", onPrimary: "#EFF3F8", onAccent: "#241A05", accentText: "#E7C382", noteText: "#E7C382", headMut: "#7A8798", faint: "#5E6B7B", disabledText: "#6E7B8B" },
  },
  lamington: {
    label: "Lamington",
    light: { bg: "#F3EEE9", card: "#FBF8F4", ink: "#2E241E", inkSoft: "#6C5A4F", green: "#4A3226", greenDeep: "#382418", mustard: "#B4466A", mustardSoft: "#F3D9E2", line: "#E0D6CC", danger: "#A93E2C", onPrimary: "#F6EFE9", onAccent: "#FBF0F4", accentText: "#7E2C4A", noteText: "#6B2540", headMut: "#8F7F72", faint: "#B2A294", disabledText: "#93836F" },
    dark: { bg: "#171210", card: "#221B16", ink: "#EDE4DC", inkSoft: "#B3A294", green: "#54382A", greenDeep: "#3E2A1E", mustard: "#D06A8C", mustardSoft: "#46202E", line: "#362B22", danger: "#D0654F", onPrimary: "#F6EFE9", onAccent: "#2E0F1A", accentText: "#EFA9C0", noteText: "#EFA9C0", headMut: "#8B7C6E", faint: "#6B5C50", disabledText: "#7B6C5E" },
  },
  plum: {
    label: "Plum",
    light: { bg: "#F4EFF1", card: "#FCF9FA", ink: "#2E2129", inkSoft: "#6B5762", green: "#5A2E4B", greenDeep: "#43223A", mustard: "#B98A2E", mustardSoft: "#F0E2C3", line: "#E0D5DA", danger: "#A93E2C", onPrimary: "#F6EFF3", onAccent: "#241A05", accentText: "#6E4E12", noteText: "#5C400C", headMut: "#907C88", faint: "#B3A3AC", disabledText: "#93838C" },
    dark: { bg: "#1A1318", card: "#251B22", ink: "#ECE2E8", inkSoft: "#B09CA8", green: "#4E2A42", greenDeep: "#3A1F32", mustard: "#D3A24A", mustardSoft: "#4A3814", line: "#3A2C35", danger: "#D0654F", onPrimary: "#F6EFF3", onAccent: "#241A05", accentText: "#E7C382", noteText: "#E7C382", headMut: "#8F7B87", faint: "#6E5D67", disabledText: "#7E6E77" },
  },
};

const THEME_LIST = Object.entries(PALETTES).map(([id, p]) => [id, p.label, p.light.green, p.light.mustard]);

const getTheme = (name, mode) => {
  const p = PALETTES[name] || PALETTES.olive;
  const t = p[mode] || p.light;
  return { ...t, onPrimarySoft: hexA(t.onPrimary, 0.8), onPrimaryFaint: hexA(t.onPrimary, 0.45), onPrimaryFaint2: hexA(t.onPrimary, 0.15) };
};

let C = getTheme("olive", "light");

const CATEGORIES = ["Weeknight", "Pasta", "Curry", "Soup", "Roast", "Salad", "Sides", "Stir-fry", "Casserole", "Cakes", "Slices", "Biscuits & Cookies", "Tarts & Pastries", "Breads", "Loaves, Muffins & Other", "Other"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const emptyPlan = () => Object.fromEntries(DAYS.map((d) => [d, []]));

/* ---------- app shell ---------- */

export default function TheKitchen() {
  const [recipes, setRecipes] = useState(null);
  const [plan, setPlan] = useState(emptyPlan());
  const [shop, setShop] = useState([]);
  const [favs, setFavs] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [myTips, setMyTips] = useState([]);
  const [myPans, setMyPans] = useState([]);
  const [bakePlans, setBakePlans] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [tab, setTab] = useState("recipes");
  const [view, setView] = useState({ page: "list" });
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("All");
  const [toast, setToast] = useState("");
  const [kitchenTimers, setKitchenTimers] = useState([]); // {id, name, total, left, running, done}
  const [sysDark, setSysDark] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e) => setSysDark(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", fn); else mq.addListener(fn);
    return () => { if (mq.removeEventListener) mq.removeEventListener("change", fn); else mq.removeListener(fn); };
  }, []);

  useEffect(() => {
    (async () => {
      const load = async (key, fallback) => {
        try { const r = await storageGet(key); return JSON.parse(r.value); }
        catch { return fallback; }
      };
      setRecipes(await load(K_RECIPES, SEED_RECIPES));
      const p = await load(K_PLAN, emptyPlan());
      setPlan({ ...emptyPlan(), ...p });
      setShop(await load(K_SHOP, []));
      setFavs(await load(K_FAVS, []));
      setTemplates(await load(K_TEMPLATES, []));
      setMyTips(await load(K_MYTIPS, []));
      setMyPans(await load(K_MYPANS, []));
      setBakePlans(await load(K_BAKEPLANS, []));
      setSettings({ ...DEFAULT_SETTINGS, ...(await load(K_SETTINGS, {})) });
    })();
  }, []);

  useEffect(() => {
    if (!kitchenTimers.some((t) => t.running)) return;
    const iv = setInterval(() => {
      setKitchenTimers((prev) =>
        prev.map((t) => {
          if (!t.running) return t;
          if (t.left <= 1) {
            beep();
            setToast(`⏱ "${t.name}" timer is done!`);
            return { ...t, left: 0, running: false, done: true };
          }
          return { ...t, left: t.left - 1 };
        })
      );
    }, 1000);
    return () => clearInterval(iv);
  }, [kitchenTimers.some((t) => t.running)]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const dirtyRef = useRef(() => {});
  const save = async (key, value) => {
    try { await storageSet(key, JSON.stringify(value)); dirtyRef.current(); }
    catch (e) { console.error(e); setToast("Couldn't save — storage may be full (large photos?)"); }
  };

  const persistRecipes = (next) => { setRecipes(next); save(K_RECIPES, next); };
  const persistPlan = (next) => { setPlan(next); save(K_PLAN, next); };
  const persistShop = (next) => { setShop(next); save(K_SHOP, next); };
  const persistFavs = (next) => { setFavs(next); save(K_FAVS, next); };
  const persistTemplates = (next) => { setTemplates(next); save(K_TEMPLATES, next); };
  const persistMyTips = (next) => { setMyTips(next); save(K_MYTIPS, next); };
  const persistMyPans = (next) => { setMyPans(next); save(K_MYPANS, next); };
  const persistBakePlans = (next) => { setBakePlans(next); save(K_BAKEPLANS, next); };
  const persistSettings = (next) => { setSettings(next); save(K_SETTINGS, next); };

  const toggleFav = (id) => {
    persistFavs(favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id]);
  };

  const saveRecipe = (recipe) => {
    const exists = recipes.some((r) => r.id === recipe.id);
    persistRecipes(exists ? recipes.map((r) => (r.id === recipe.id ? recipe : r)) : [recipe, ...recipes]);
    setView({ page: "recipe", id: recipe.id });
  };

  const patchRecipe = (id, patch) => {
    persistRecipes(recipes.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const markCooked = (id) => {
    const r = recipes.find((x) => x.id === id);
    if (!r) return;
    patchRecipe(id, { cooked: [...(r.cooked || []), new Date().toISOString()] });
    setToast("Marked as cooked — enjoy!");
  };

  const deleteRecipe = (id) => {
    persistRecipes(recipes.filter((r) => r.id !== id));
    persistFavs(favs.filter((f) => f !== id));
    persistPlan(Object.fromEntries(DAYS.map((d) => [d, plan[d].filter((e) => e.recipeId !== id)])));
    setView({ page: "list" });
  };

  /* --- shopping list merging --- */

  const mergeIntoShop = (items) => {
    const next = [...shop];
    for (const it of items) {
      if (it.amount == null) {
        const dup = next.find((n) => n.amount == null && n.name.toLowerCase() === it.name.toLowerCase());
        if (!dup) next.push({ id: uid(), name: it.name, unit: "", amount: null, checked: false });
        continue;
      }
      const canon = canonicalItemName(it.name);
      const match = next.find(
        (n) => n.amount != null && n.unit === it.unit && canonicalItemName(n.name).toLowerCase() === canon.toLowerCase() && !n.checked
      );
      if (match) { match.amount += it.amount; match.name = canonicalItemName(match.name); }
      else next.push({ id: uid(), name: canon, unit: it.unit, amount: it.amount, checked: false });
    }
    persistShop(next);
  };

  const addRecipeToShop = (recipe, factor, label) => {
    mergeIntoShop(recipe.ingredients.map((i) => ({ ...i, amount: i.amount != null ? i.amount * factor : null })));
    setToast(`${recipe.title} (${label}) added to shopping list`);
  };

  const addWeekToShop = () => {
    const items = [];
    let count = 0;
    for (const d of DAYS) {
      for (const e of plan[d]) {
        if (e.leftover) continue;
        const r = recipes.find((x) => x.id === e.recipeId);
        if (!r) continue;
        count++;
        const factor = scalingKind(r) === "serves" ? e.servings / r.baseServings : e.servings;
        for (const i of r.ingredients) items.push({ ...i, amount: i.amount != null ? i.amount * factor : null });
      }
    }
    if (!count) { setToast("The planner is empty — add some meals first"); return; }
    mergeIntoShop(items);
    setToast(`Ingredients for ${count} meal${count > 1 ? "s" : ""} added to shopping list`);
    setTab("shopping");
  };

  const addToPlan = (day, recipeId, servings, leftover = false) => {
    persistPlan({ ...plan, [day]: [...plan[day], { id: uid(), recipeId, servings, ...(leftover ? { leftover: true } : {}) }] });
    setToast(leftover ? `Leftovers night added to ${day} — nothing extra to buy` : `Added to ${day}`);
  };

  const sendBakePlanToShop = (pl) => {
    const items = [];
    for (const e of pl.entries) {
      const r = recipes.find((x) => x.id === e.recipeId);
      if (!r) continue;
      for (const i of r.ingredients) items.push({ ...i, amount: i.amount != null ? i.amount * e.factor : null });
    }
    if (!items.length) { setToast("Add some recipes to the plan first"); return; }
    mergeIntoShop(items);
    setToast(`Ingredients for “${pl.name}” added to shopping list`);
    setTab("shopping");
  };

  /* --- week templates --- */

  const saveTemplate = (name) => {
    persistTemplates([...templates, { id: uid(), name, plan }]);
    setToast(`Saved template “${name}”`);
  };
  const applyTemplate = (tpl) => {
    const fresh = Object.fromEntries(DAYS.map((d) => [d, (tpl.plan[d] || []).map((e) => ({ ...e, id: uid() }))]));
    persistPlan(fresh);
    setToast(`Applied “${tpl.name}” to this week`);
  };
  const deleteTemplate = (id) => persistTemplates(templates.filter((t) => t.id !== id));

  /* --- cloud sync (Supabase) --- */

  const [cloudUser, setCloudUser] = useState(null);
  const [cloudStatus, setCloudStatus] = useState("");
  const pushTimer = useRef(null);
  const pulledRef = useRef(false);
  const collectRef = useRef(() => null);
  collectRef.current = () => ({ recipes, plan, shop, favs, templates, myTips, myPans, bakePlans, settings });

  const applyRemoteData = (d) => {
    if (!d || !Array.isArray(d.recipes)) return;
    persistRecipes(d.recipes);
    persistPlan({ ...emptyPlan(), ...(d.plan || {}) });
    persistShop(Array.isArray(d.shop) ? d.shop : []);
    persistFavs(Array.isArray(d.favs) ? d.favs : []);
    persistTemplates(Array.isArray(d.templates) ? d.templates : []);
    persistMyTips(Array.isArray(d.myTips) ? d.myTips : []);
    persistMyPans(Array.isArray(d.myPans) ? d.myPans : []);
    persistBakePlans(Array.isArray(d.bakePlans) ? d.bakePlans : []);
    persistSettings({ ...DEFAULT_SETTINGS, ...(d.settings || {}) });
  };

  const cloudPush = async () => {
    if (!syncConfigured || !cloudUser || !recipes) return;
    try {
      setCloudStatus("Syncing…");
      await pushKitchen(collectRef.current());
      setCloudStatus(`Synced ${new Date().toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}`);
    } catch (e) {
      console.error(e);
      setCloudStatus("Sync failed — will retry on the next change");
    }
  };

  dirtyRef.current = () => {
    if (!syncConfigured || !cloudUser) return;
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(cloudPush, 4000);
  };

  useEffect(() => {
    if (!syncConfigured) return;
    supabase.auth.getSession().then(({ data }) => setCloudUser(data.session ? data.session.user : null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setCloudUser(session ? session.user : null));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!syncConfigured || !cloudUser || !recipes || pulledRef.current) return;
    pulledRef.current = true;
    (async () => {
      try {
        setCloudStatus("Checking the cloud…");
        const remote = await fetchKitchen();
        if (remote && remote.data && Array.isArray(remote.data.recipes)) {
          applyRemoteData(remote.data);
          setCloudStatus(`Pulled cloud copy · ${remote.data.recipes.length} recipes`);
          setToast("Synced from the cloud");
        } else {
          await cloudPush();
        }
      } catch (e) {
        console.error(e);
        setCloudStatus("Couldn't reach sync — working locally");
      }
    })();
  }, [cloudUser, !!recipes]);

  const cloudSignIn = async (email) => {
    try {
      await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + window.location.pathname } });
      setToast("Sign-in link sent — check your email on this device");
    } catch (e) { console.error(e); setToast("Couldn't send the sign-in link"); }
  };
  const cloudSignOut = async () => {
    await supabase.auth.signOut();
    pulledRef.current = false;
    setCloudStatus("");
    setToast("Signed out — this device keeps its local copy");
  };

  /* --- backup --- */

  const exportData = async () => {
    const payload = JSON.stringify(
      { app: "becs-kitchen", exported: new Date().toISOString(), recipes, plan, shop, favs, templates, myTips, myPans, bakePlans, settings },
      null, 2
    );
    try {
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `the-kitchen-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setToast("Backup downloaded");
    } catch {
      try { await navigator.clipboard.writeText(payload); setToast("Download blocked here — backup copied to clipboard instead"); }
      catch { setToast("Couldn't export on this device"); }
    }
  };

  const importData = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        if (!Array.isArray(d.recipes)) throw new Error("bad backup");
        persistRecipes(d.recipes);
        persistPlan({ ...emptyPlan(), ...(d.plan || {}) });
        persistShop(Array.isArray(d.shop) ? d.shop : []);
        persistFavs(Array.isArray(d.favs) ? d.favs : []);
        persistTemplates(Array.isArray(d.templates) ? d.templates : []);
        persistMyTips(Array.isArray(d.myTips) ? d.myTips : []);
        persistMyPans(Array.isArray(d.myPans) ? d.myPans : []);
        persistBakePlans(Array.isArray(d.bakePlans) ? d.bakePlans : []);
        persistSettings({ ...DEFAULT_SETTINGS, ...(d.settings || {}) });
        setView({ page: "list" });
        setToast(`Imported ${d.recipes.length} recipes from backup`);
      } catch { setToast("That file doesn't look like a The Kitchen backup"); }
    };
    reader.readAsText(file);
  };

  const resolvedMode = settings.mode === "auto" ? (sysDark ? "dark" : "light") : settings.mode;
  C = getTheme(settings.theme, resolvedMode);

  if (!recipes) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "grid", placeItems: "center", fontFamily: "'Instrument Sans', sans-serif", color: C.inkSoft }}>
        Setting the table…
      </div>
    );
  }

  const current = view.id ? recipes.find((r) => r.id === view.id) : null;
  const plannedCount = DAYS.reduce((a, d) => a + plan[d].length, 0) + bakePlans.length;
  const unchecked = shop.filter((s) => !s.checked).length;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "'Instrument Sans', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Instrument+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        button { font-family: inherit; cursor: pointer; color: inherit; }
        input, textarea, select { font-family: inherit; font-size: 15px; color: ${C.ink}; }
        input:focus, textarea:focus, select:focus, button:focus-visible { outline: 2px solid ${C.mustard}; outline-offset: 1px; }
        ::placeholder { color: ${C.faint}; }
        .tabnav { scrollbar-width: none; }
        .tabnav::-webkit-scrollbar { display: none; }
        @keyframes toastIn { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
        @keyframes timerDone { 0%, 100% { background: ${C.mustard}; } 50% { background: ${C.danger}; } }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
      `}</style>

      <header style={{ background: C.green, color: C.onPrimary, padding: "18px 20px 0" }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <button
              onClick={() => { setTab("recipes"); setView({ page: "list" }); }}
              style={{ background: "none", border: "none", color: "inherit", padding: 0, textAlign: "left" }}
            >
              <div style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 28, lineHeight: 1 }}>The Kitchen</div>
              <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>Everyday cooking, scaled to whoever turns up</div>
            </button>
            <button
              onClick={() => { setTab("recipes"); setView({ page: "edit" }); }}
              style={{ background: C.mustard, color: C.onAccent, border: "none", borderRadius: 999, padding: "10px 18px", fontWeight: 600, fontSize: 14 }}
            >
              + New recipe
            </button>
          </div>
          <nav style={{ display: "flex", gap: 2, marginTop: 14 }}>
            {[
              ["recipes", "Recipes", 0],
              ["planner", "Plan", plannedCount],
              ["shopping", "Shop", unchecked],
              ["tips", "Tips", kitchenTimers.filter((t) => t.running).length],
              ["settings", "Settings", 0],
            ].map(([id, label, badge]) => (
              <button
                key={id}
                onClick={() => { setTab(id); if (id === "recipes") setView({ page: "list" }); }}
                style={{
                  flex: 1, minWidth: 0,
                  background: tab === id ? C.bg : "transparent",
                  color: tab === id ? C.ink : C.onPrimarySoft,
                  border: "none", borderRadius: "10px 10px 0 0", padding: "11px 2px",
                  fontSize: 12.5, fontWeight: 600,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
                }}
              >
                {label}
                {badge > 0 && (
                  <span style={{ background: C.mustard, color: C.onAccent, borderRadius: 999, fontSize: 10, fontWeight: 700, minWidth: 16, height: 16, display: "grid", placeItems: "center", padding: "0 4px", lineHeight: 1 }}>
                    {badge}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 860, margin: "0 auto", padding: "24px 20px 80px" }}>
        {tab === "recipes" && view.page === "list" && (
          <ListPage
            recipes={recipes} favs={favs} toggleFav={toggleFav}
            query={query} setQuery={setQuery} cat={cat} setCat={setCat}
            open={(id) => setView({ page: "recipe", id })}
          />
        )}
        {tab === "recipes" && view.page === "recipe" && current && (
          <RecipePage
            recipe={current}
            settings={settings}
            myPans={myPans}
            allRecipes={recipes}
            favIds={favs}
            onOpenRecipe={(id) => setView({ page: "recipe", id })}
            fav={favs.includes(current.id)}
            toggleFav={() => toggleFav(current.id)}
            onBack={() => setView({ page: "list" })}
            onEdit={() => setView({ page: "edit", id: current.id })}
            onDelete={() => deleteRecipe(current.id)}
            onAddToShop={(factor, label) => addRecipeToShop(current, factor, label)}
            onAddToPlan={(day, servings) => addToPlan(day, current.id, servings)}
            onPatch={(patch) => patchRecipe(current.id, patch)}
            onCooked={() => markCooked(current.id)}
          />
        )}
        {tab === "recipes" && view.page === "edit" && (
          <EditPage
            recipe={view.id ? current : null}
            settings={settings}
            onCancel={() => setView(view.id ? { page: "recipe", id: view.id } : { page: "list" })}
            onSave={saveRecipe}
          />
        )}
        {tab === "planner" && (
          <PlannerPage
            plan={plan} recipes={recipes} settings={settings}
            bakePlans={bakePlans}
            setBakePlans={persistBakePlans}
            sendBakePlanToShop={sendBakePlanToShop}
            onToast={setToast}
            templates={templates}
            onSaveTemplate={saveTemplate}
            onApplyTemplate={applyTemplate}
            onDeleteTemplate={deleteTemplate}
            setEntryServings={(day, entryId, delta) => {
              persistPlan({
                ...plan,
                [day]: plan[day].map((e) => (e.id === entryId ? { ...e, servings: Math.min(40, Math.max(1, e.servings + delta)) } : e)),
              });
            }}
            removeEntry={(day, entryId) => persistPlan({ ...plan, [day]: plan[day].filter((e) => e.id !== entryId) })}
            addEntry={addToPlan}
            clearWeek={() => persistPlan(emptyPlan())}
            addWeekToShop={addWeekToShop}
            openRecipe={(id) => { setTab("recipes"); setView({ page: "recipe", id }); }}
          />
        )}
        {tab === "tips" && (
          <TipsPage
            kitchenTimers={kitchenTimers}
            setKitchenTimers={setKitchenTimers}
            myTips={myTips}
            onAddTip={(tip) => { persistMyTips([...myTips, { id: uid(), ...tip }]); setToast("Tip saved"); }}
            onRemoveTip={(id) => persistMyTips(myTips.filter((t) => t.id !== id))}
          />
        )}
        {tab === "settings" && (
          <SettingsPage
            settings={settings}
            update={(patch) => persistSettings({ ...settings, ...patch })}
            myPans={myPans}
            onAddPan={(pan) => { persistMyPans([...myPans, { id: uid(), ...pan }]); setToast(`Saved pan: ${pan.name || panLabel(pan)}`); }}
            onRemovePan={(id) => persistMyPans(myPans.filter((p) => p.id !== id))}
            onExport={exportData}
            onImport={importData}
            restoreStarters={() => {
              const missing = SEED_RECIPES.filter((s) => !recipes.some((r) => r.id === s.id));
              if (!missing.length) { setToast("All starter recipes are already in your collection"); return; }
              persistRecipes([...missing, ...recipes]);
              setToast(`Restored ${missing.length} starter recipe${missing.length > 1 ? "s" : ""}`);
            }}
            resetAll={() => {
              persistRecipes(SEED_RECIPES);
              persistPlan(emptyPlan());
              persistShop([]);
              persistFavs([]);
              persistTemplates([]);
              persistSettings(DEFAULT_SETTINGS);
              setToast("Everything reset to a fresh kitchen");
            }}
          />
        )}
        {tab === "settings" && (
          <div style={{ maxWidth: 620 }}>
            <CloudSyncCard user={cloudUser} status={cloudStatus} onSignIn={cloudSignIn} onSignOut={cloudSignOut} onSyncNow={cloudPush} />
          </div>
        )}
        {tab === "shopping" && (
          <ShoppingPage
            items={shop}
            toggle={(id) => persistShop(shop.map((s) => (s.id === id ? { ...s, checked: !s.checked } : s)))}
            remove={(id) => persistShop(shop.filter((s) => s.id !== id))}
            addManual={(text) => {
              const parsed = parseIngredientLine(text);
              if (parsed) mergeIntoShop([parsed]);
            }}
            clearChecked={() => persistShop(shop.filter((s) => !s.checked))}
            clearAll={() => persistShop([])}
            onToast={setToast}
          />
        )}
      </main>

      {toast && (
        <div style={{
          position: "fixed", bottom: "calc(24px + env(safe-area-inset-bottom))", left: "50%", transform: "translateX(-50%)",
          background: C.greenDeep, color: C.onPrimary, padding: "12px 22px", borderRadius: 999,
          fontSize: 14, fontWeight: 500, boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
          animation: "toastIn 0.2s ease", zIndex: 90, maxWidth: "90vw", textAlign: "center",
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/* ---------- recipe list ---------- */

function ListPage({ recipes, favs, toggleFav, query, setQuery, cat, setCat, open }) {
  const [fridgeOpen, setFridgeOpen] = useState(false);
  const [skillFilter, setSkillFilter] = useState("All");
  const cats = ["All", "★ Favourites", ...Array.from(new Set(recipes.map((r) => r.category).filter(Boolean)))];
  const filtered = recipes.filter((r) => {
    const okCat = cat === "All" || (cat === "★ Favourites" ? favs.includes(r.id) : r.category === cat);
    const okQ = !query || r.title.toLowerCase().includes(query.toLowerCase());
    const okSkill = skillFilter === "All" || skillOf(r) === skillFilter;
    return okCat && okQ && okSkill;
  });

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search recipes"
          style={{ flex: 1, padding: "12px 16px", borderRadius: 12, border: `1px solid ${C.line}`, background: C.card }}
        />
        <button
          onClick={() => setFridgeOpen(!fridgeOpen)}
          style={{
            border: `1px solid ${fridgeOpen ? C.green : C.line}`,
            background: fridgeOpen ? C.green : C.card,
            color: fridgeOpen ? C.onPrimary : C.inkSoft,
            borderRadius: 12, padding: "0 16px", fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap",
          }}
        >
          What can I make?
        </button>
      </div>

      {fridgeOpen && <WhatCanIMake recipes={recipes} open={open} />}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {cats.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            style={{
              border: `1px solid ${c === cat ? C.green : C.line}`,
              background: c === cat ? C.green : C.card,
              color: c === cat ? C.onPrimary : C.inkSoft,
              borderRadius: 999, padding: "6px 14px", fontSize: 13, fontWeight: 500,
            }}
          >
            {c}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20, alignItems: "center" }}>
        <span style={{ fontSize: 11.5, color: C.faint, fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase" }}>Skill</span>
        {["All", ...SKILL_LEVELS].map((s) => {
          const active = skillFilter === s;
          const col = s === "All" ? C.inkSoft : skillColor(s);
          return (
            <button
              key={s}
              onClick={() => setSkillFilter(s)}
              style={{
                border: `1px solid ${active ? col : C.line}`,
                background: active ? (s === "All" ? C.green : col) : C.card,
                color: active ? C.onPrimary : col,
                borderRadius: 999, padding: "4px 12px", fontSize: 12, fontWeight: 600,
              }}
            >
              {s === "All" ? "All levels" : s}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div style={{ color: C.inkSoft, padding: "40px 0", textAlign: "center" }}>
          {cat === "★ Favourites" && skillFilter === "All"
            ? "No favourites yet — tap the star on any recipe."
            : "No recipes match those filters. Try a different skill level or category."}
        </div>
      )}

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
        {filtered.map((r) => (
          <div key={r.id} style={{ position: "relative" }}>
            <button
              onClick={() => open(r.id)}
              style={{
                width: "100%", textAlign: "left", background: C.card, border: `1px solid ${C.line}`,
                borderRadius: 14, padding: 0, overflow: "hidden", display: "flex", flexDirection: "column",
              }}
            >
              {r.photo && (
                <img src={r.photo} alt="" style={{ width: "100%", height: 120, objectFit: "cover", display: "block" }} />
              )}
              <div style={{ padding: "14px 44px 12px 16px", display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 600, fontSize: 19, lineHeight: 1.2 }}>{r.title}</div>
                <div style={{ display: "flex", gap: 8, fontSize: 12.5, color: C.inkSoft, alignItems: "center", flexWrap: "wrap" }}>
                  {r.category && <span style={{ background: C.mustardSoft, color: C.accentText, padding: "2px 9px", borderRadius: 999, fontWeight: 600 }}>{r.category}</span>}
                  <span style={{ border: `1px solid ${skillColor(skillOf(r))}`, color: skillColor(skillOf(r)), padding: "1px 8px", borderRadius: 999, fontWeight: 600, fontSize: 11.5 }}>{skillOf(r)}</span>
                  <span>{scalingKind(r) === "serves" ? `Serves ${r.baseServings}` : scalingKind(r) === "pan" ? panLabel(r.basePan) : (r.yield || "Batch")}</span>
                  {r.time && <span>· {r.time}</span>}
                </div>
                {(r.rating > 0 || (r.cooked || []).length > 0) && (
                  <div style={{ display: "flex", gap: 8, fontSize: 12, color: C.inkSoft, alignItems: "center" }}>
                    {r.rating > 0 && <span style={{ color: C.mustard, letterSpacing: 1 }}>{"★".repeat(r.rating)}</span>}
                    {(r.cooked || []).length > 0 && <span>last made {timeAgo(r.cooked[r.cooked.length - 1])}</span>}
                  </div>
                )}
              </div>
            </button>
            <button
              onClick={() => toggleFav(r.id)}
              aria-label={favs.includes(r.id) ? "Remove from favourites" : "Add to favourites"}
              style={{
                position: "absolute", top: 8, right: 8, border: "none",
                background: r.photo ? "rgba(0,0,0,0.35)" : "none", borderRadius: 999,
                fontSize: 20, lineHeight: 1, color: favs.includes(r.id) ? C.mustard : (r.photo ? "#FFFFFF" : C.faint), padding: 6,
              }}
            >
              {favs.includes(r.id) ? "★" : "☆"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function WhatCanIMake({ recipes, open }) {
  const [text, setText] = useState("");
  const have = text.toLowerCase().split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  const ranked = have.length
    ? recipes
        .map((r) => {
          const need = r.ingredients.filter((i) => !/to (serve|taste)/i.test(i.name));
          const missing = need.filter((i) => !have.some((h) => i.name.toLowerCase().includes(h)));
          return { r, missing, total: need.length };
        })
        .sort((a, b) => a.missing.length - b.missing.length)
        .slice(0, 6)
    : [];

  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px", marginBottom: 14 }}>
      <div style={{ fontSize: 13.5, color: C.inkSoft, marginBottom: 8, lineHeight: 1.5 }}>
        List what's in the fridge and pantry (separated by commas) and I'll rank your recipes by fewest missing ingredients.
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="chicken thighs, rice, eggs, soy sauce, spring onions"
        style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, resize: "vertical", lineHeight: 1.5 }}
      />
      {ranked.map(({ r, missing }) => (
        <button
          key={r.id}
          onClick={() => open(r.id)}
          style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderTop: `1px solid ${C.line}`, padding: "10px 2px", marginTop: 8 }}
        >
          <span style={{ fontWeight: 600, fontSize: 14.5 }}>{r.title}</span>
          <div style={{ fontSize: 12.5, marginTop: 2, color: missing.length === 0 ? C.green : C.inkSoft }}>
            {missing.length === 0
              ? "✓ You have everything"
              : `Missing ${missing.length}: ${missing.slice(0, 3).map((m) => m.name.split(",")[0]).join(", ")}${missing.length > 3 ? "…" : ""}`}
          </div>
        </button>
      ))}
    </div>
  );
}

/* ---------- recipe view ---------- */

function RecipePage({ recipe, settings, myPans = [], allRecipes = [], favIds = [], onOpenRecipe, fav, toggleFav, onBack, onEdit, onDelete, onAddToShop, onAddToPlan, onPatch, onCooked }) {
  const kind = scalingKind(recipe);
  const startServes = settings.defaultServes || recipe.baseServings;
  const [servings, setServings] = useState(startServes);
  const [batch, setBatch] = useState(1);
  const [pan, setPan] = useState(recipe.basePan || null);
  const [customPan, setCustomPan] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pickDay, setPickDay] = useState(false);
  const [cooking, setCooking] = useState(false);
  const [ticked, setTicked] = useState(() => new Set());

  const factor =
    kind === "serves" ? servings / recipe.baseServings :
    kind === "batch" ? batch :
    (recipe.basePan && pan && panArea(recipe.basePan) > 0 ? panArea(pan) / panArea(recipe.basePan) : 1);
  const scaled = Math.abs(factor - 1) > 0.001;
  const cooked = recipe.cooked || [];

  const scaleLabel =
    kind === "serves" ? `serves ${servings}` :
    kind === "batch" ? `×${fmtFactor(batch)} batch` :
    panLabel(pan);

  useEffect(() => {
    setServings(startServes);
    setBatch(1);
    setPan(recipe.basePan || null);
    setCustomPan(false);
    setConfirmDelete(false); setPickDay(false); setCooking(false);
  }, [recipe.id]);

  // prep ticks are per-session: clear on a new recipe or when amounts rescale
  useEffect(() => { setTicked(new Set()); }, [recipe.id, factor]);

  const prepOn = settings.prepTicks !== false;
  const toggleTick = (i) =>
    setTicked((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8, flexWrap: "wrap" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: C.inkSoft, fontSize: 14, padding: "6px 0", fontWeight: 500 }}>
          ← All recipes
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={toggleFav} aria-label="Toggle favourite" style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 999, padding: "7px 14px", fontSize: 15, color: fav ? C.mustard : C.inkSoft }}>
            {fav ? "★" : "☆"}
          </button>
          <button onClick={onEdit} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 999, padding: "7px 16px", fontSize: 13, fontWeight: 500 }}>Edit</button>
          {!confirmDelete ? (
            <button onClick={() => setConfirmDelete(true)} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 999, padding: "7px 16px", fontSize: 13, color: C.danger, fontWeight: 500 }}>Delete</button>
          ) : (
            <button onClick={onDelete} style={{ background: C.danger, border: "none", color: "#fff", borderRadius: 999, padding: "7px 16px", fontSize: 13, fontWeight: 600 }}>Confirm delete</button>
          )}
        </div>
      </div>

      {recipe.photo && (
        <img src={recipe.photo} alt={recipe.title} style={{ width: "100%", maxHeight: 260, objectFit: "cover", borderRadius: 16, marginBottom: 16, display: "block" }} />
      )}

      <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 34, margin: "0 0 6px", lineHeight: 1.1 }}>{recipe.title}</h1>
      <div style={{ color: C.inkSoft, fontSize: 14, marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ border: `1px solid ${skillColor(skillOf(recipe))}`, color: skillColor(skillOf(recipe)), padding: "1px 10px", borderRadius: 999, fontWeight: 600, fontSize: 12 }}>{skillOf(recipe)}</span>
        <span>
          {recipe.category}
          {recipe.time ? ` · ${recipe.time}` : ""}
          {recipe.temp ? ` · ${applyOven(recipe.temp, settings.oven)}` : ""}
          {kind === "batch" && recipe.yield ? ` · ${scaleYield(recipe.yield, batch)}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
        <Stars value={recipe.rating || 0} onChange={(n) => onPatch({ rating: n === recipe.rating ? 0 : n })} />
        <span style={{ fontSize: 13, color: C.inkSoft }}>
          {cooked.length ? `Cooked ${cooked.length}× · last made ${timeAgo(cooked[cooked.length - 1])}` : "Not cooked yet"}
        </span>
        <button
          onClick={onCooked}
          style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 999, padding: "5px 13px", fontSize: 12.5, color: C.inkSoft, fontWeight: 500 }}
        >
          Mark cooked
        </button>
      </div>

      {kind === "serves" && (
        <div style={{ background: C.green, color: C.onPrimary, borderRadius: 16, padding: "16px 20px", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", opacity: 0.7, fontWeight: 600 }}>Serves</div>
              <div style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 40, lineHeight: 1 }}>{servings}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <Stepper label="−" disabled={servings <= 1} onClick={() => setServings((s) => Math.max(1, s - 1))} />
              <Stepper label="+" disabled={servings >= 40} onClick={() => setServings((s) => Math.min(40, s + 1))} />
              <button
                onClick={() => setServings(recipe.baseServings)}
                aria-hidden={!scaled}
                tabIndex={scaled ? 0 : -1}
                style={{ background: "none", border: `1px solid ${C.onPrimaryFaint}`, color: C.onPrimary, borderRadius: 999, padding: "8px 13px", fontSize: 13, visibility: scaled ? "visible" : "hidden" }}
              >
                Reset
              </button>
            </div>
          </div>
          <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 8 }}>
            {scaled
              ? `Scaled from ${recipe.baseServings}${settings.defaultServes ? " (your household default)" : ""} — amounts updated below`
              : "Recipe as written"}
          </div>
          {(() => {
            const pots = myPans.filter((p) => p.shape === "dutch");
            if (!pots.length || !["Casserole", "Soup", "Curry", "Stew"].includes(recipe.category)) return null;
            return (
              <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6 }}>
                🍲 {pots.map((p) => `${p.name || panLabel(p)} fits ~${Math.max(1, Math.floor((Number(p.litres) * 1000 * 0.8) / 600))} serves`).join(" · ")}
              </div>
            );
          })()}
        </div>
      )}

      {kind === "batch" && (
        <div style={{ background: C.green, color: C.onPrimary, borderRadius: 16, padding: "16px 20px", marginBottom: 14 }}>
          <div style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", opacity: 0.7, fontWeight: 600, marginBottom: 8 }}>Batch size</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {BATCH_OPTIONS.map((b) => (
              <button
                key={b}
                onClick={() => setBatch(b)}
                style={{
                  background: batch === b ? C.onPrimary : "transparent",
                  color: batch === b ? C.greenDeep : C.onPrimary,
                  border: `1px solid ${batch === b ? C.onPrimary : C.onPrimaryFaint}`,
                  borderRadius: 999, padding: "9px 18px", fontSize: 14.5, fontWeight: 700,
                }}
              >
                ×{fmtFactor(b)}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 10 }}>
            {recipe.yield ? scaleYield(recipe.yield, batch) : (batch === 1 ? "Recipe as written" : `×${fmtFactor(batch)} the original`)}
            {scaled ? " — amounts updated below" : ""}
          </div>
        </div>
      )}

      {kind === "pan" && (
        <div style={{ background: C.green, color: C.onPrimary, borderRadius: 16, padding: "16px 20px", marginBottom: 14 }}>
          <div style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", opacity: 0.7, fontWeight: 600, marginBottom: 4 }}>Baking pan</div>
          <div style={{ fontSize: 12.5, opacity: 0.75, marginBottom: 10 }}>
            Written for {panLabel(recipe.basePan)} — pick your pan and the amounts rescale.
            {!myPans.length ? " Save your own tins in Settings → My pans and they'll appear here." : ""}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              recipe.basePan,
              ...myPans.filter((p) => !samePan(p, recipe.basePan)),
            ].map((p, i) => {
              const active = !customPan && samePan(pan, p);
              return (
                <button
                  key={i}
                  onClick={() => { setPan(p); setCustomPan(false); }}
                  style={{
                    background: active ? C.onPrimary : "transparent",
                    color: active ? C.greenDeep : C.onPrimary,
                    border: `1px solid ${active ? C.onPrimary : C.onPrimaryFaint}`,
                    borderRadius: 999, padding: "8px 15px", fontSize: 13, fontWeight: 600,
                  }}
                >
                  {p.name || panLabel(p)}{i === 0 ? " (as written)" : ""}
                </button>
              );
            })}
            <button
              onClick={() => setCustomPan(!customPan)}
              style={{
                background: customPan ? C.onPrimary : "transparent",
                color: customPan ? C.greenDeep : C.onPrimary,
                border: `1px solid ${customPan ? C.onPrimary : C.onPrimaryFaint}`,
                borderRadius: 999, padding: "8px 15px", fontSize: 13, fontWeight: 600,
              }}
            >
              Custom…
            </button>
          </div>
          {customPan && <PanPicker pan={pan} basePan={recipe.basePan} onChange={setPan} />}
          <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 10 }}>
            {scaled
              ? `Scaling ×${Math.round(factor * 100) / 100} by pan area — amounts updated below. Bake time will shift a little: same temperature, start checking earlier for thinner bakes and allow longer for deeper ones.`
              : "Recipe as written"}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 22, alignItems: "center" }}>
        <button
          onClick={() => setCooking(true)}
          style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "9px 20px", fontWeight: 600, fontSize: 13.5 }}
        >
          ▶ Cook
        </button>
        <button
          onClick={() => onAddToShop(factor, scaleLabel)}
          style={{ background: C.mustard, color: C.onAccent, border: "none", borderRadius: 999, padding: "9px 18px", fontWeight: 600, fontSize: 13.5 }}
        >
          Add to shopping list · {scaleLabel}
        </button>
        {!pickDay ? (
          <button
            onClick={() => setPickDay(true)}
            style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 999, padding: "9px 18px", fontWeight: 500, fontSize: 13.5, color: C.ink }}
          >
            Add to planner…
          </button>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {DAYS.map((d) => (
              <button
                key={d}
                onClick={() => { onAddToPlan(d, kind === "serves" ? servings : factor); setPickDay(false); }}
                style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 999, padding: "7px 13px", fontSize: 12.5, fontWeight: 500 }}
              >
                {d.slice(0, 3)}
              </button>
            ))}
            <button onClick={() => setPickDay(false)} style={{ background: "none", border: "none", color: C.inkSoft, fontSize: 12.5, padding: 6 }}>Cancel</button>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18, alignItems: "start" }}>
        <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "18px 20px" }}>
          <h2 style={{ ...sectionHead(), marginBottom: prepOn && ticked.size > 0 ? 2 : 8 }}>Ingredients</h2>
          {prepOn && ticked.size > 0 && (
            <div style={{ fontSize: 12, color: ticked.size === recipe.ingredients.length ? C.green : C.inkSoft, fontWeight: 600, marginBottom: 8 }}>
              {ticked.size === recipe.ingredients.length ? "✓ Everything measured — mise en place complete" : `${ticked.size} of ${recipe.ingredients.length} measured`}
            </div>
          )}
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {recipe.ingredients.map((it, i) => {
              const amt = it.amount != null ? formatAmount(it.amount * factor, it.unit) : null;
              const done = prepOn && ticked.has(i);
              return (
                <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: i < recipe.ingredients.length - 1 ? `1px solid ${C.line}` : "none", fontSize: 15, lineHeight: 1.45, opacity: done ? 0.55 : 1, transition: "opacity 0.15s" }}>
                  {prepOn && (
                    <button
                      onClick={() => toggleTick(i)}
                      aria-label={done ? "Mark not measured" : "Mark measured and prepped"}
                      style={{
                        width: 20, height: 20, borderRadius: 6, flexShrink: 0, marginTop: 1,
                        border: `2px solid ${done ? C.green : C.line}`,
                        background: done ? C.green : "transparent",
                        color: C.onPrimary, fontSize: 12, lineHeight: 1, display: "grid", placeItems: "center", padding: 0,
                      }}
                    >
                      {done ? "✓" : ""}
                    </button>
                  )}
                  <span style={{ flex: 1 }}>
                    {amt != null ? (
                      <>
                        <span style={{ fontWeight: 600, color: scaled ? C.mustard : C.ink, transition: "color 0.2s" }}>
                          {amt}{it.unit ? ` ${it.unit}` : ""}
                        </span>{" "}
                        {it.name}
                      </>
                    ) : (
                      <span style={{ color: C.inkSoft }}>{it.name}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "18px 20px" }}>
          <h2 style={sectionHead()}>Method</h2>
          <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {recipe.steps.map((s, i) => (
              <li key={i} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: i < recipe.steps.length - 1 ? `1px solid ${C.line}` : "none" }}>
                <span style={{ flexShrink: 0, width: 26, height: 26, borderRadius: "50%", background: C.mustardSoft, color: C.accentText, display: "grid", placeItems: "center", fontWeight: 700, fontSize: 13 }}>{i + 1}</span>
                <span style={{ fontSize: 15, lineHeight: 1.5 }}>{applyOven(s, settings.oven)}</span>
              </li>
            ))}
          </ol>
          {settings.oven === "conventional" && /\d{2,3}\s*°C/.test(recipe.steps.join(" ") + " " + (recipe.temp || "")) && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: C.inkSoft }}>
              Oven temperatures shown adjusted for a conventional oven (+20°C on the fan-forced original).
            </div>
          )}
          {recipe.notes && (
            <div style={{ marginTop: 16, background: C.mustardSoft, borderRadius: 10, padding: "10px 14px", fontSize: 13.5, color: C.noteText, lineHeight: 1.5 }}>
              <strong>Note:</strong> {recipe.notes}
            </div>
          )}
        </section>
      </div>

      <SimilarRecipes recipe={recipe} recipes={allRecipes} favIds={favIds} open={onOpenRecipe} />

      {cooking && (
        <CookMode
          recipe={recipe}
          factor={factor}
          contextLabel={scaleLabel}
          settings={settings}
          ticked={prepOn ? ticked : null}
          onToggleTick={prepOn ? toggleTick : null}
          onClose={() => setCooking(false)}
          onCooked={() => { onCooked(); setCooking(false); }}
        />
      )}
    </div>
  );
}

function PanPicker({ pan, basePan, onChange }) {
  const p = pan || basePan || { shape: "round", diameter: 20, quantity: 1 };
  const set = (key, value) => onChange({ ...p, [key]: value });
  const num = (v) => (v === "" ? "" : Math.max(1, Number(v)));
  const box = { width: 76, padding: "8px 10px", borderRadius: 8, border: "none", background: C.onPrimary, color: C.greenDeep, fontSize: 14, fontWeight: 600 };
  const lab = { fontSize: 11.5, opacity: 0.75, display: "block", marginBottom: 4 };
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12, alignItems: "flex-end" }}>
      <div>
        <span style={lab}>Shape</span>
        <select
          value={p.shape}
          onChange={(e) => {
            const shape = e.target.value;
            if (shape === "round") onChange({ shape, diameter: p.diameter || 20, quantity: p.quantity || 1 });
            else if (shape === "square") onChange({ shape, side: p.side || 20, quantity: p.quantity || 1 });
            else if (shape === "bundt") onChange({ shape, cups: p.cups || 10, quantity: p.quantity || 1 });
            else if (shape === "dutch") onChange({ shape, litres: p.litres || 5, quantity: p.quantity || 1 });
            else if (shape === "loaf") onChange({ shape, length: p.length || 26, width: p.width || 13, quantity: p.quantity || 1 });
            else onChange({ shape: "rectangle", length: p.length || 30, width: p.width || 20, quantity: p.quantity || 1 });
          }}
          style={{ ...box, width: 120 }}
        >
          <option value="round">Round</option>
          <option value="square">Square</option>
          <option value="rectangle">Rectangle</option>
          <option value="loaf">Cast-iron loaf</option>
          <option value="bundt">Bundt (cups)</option>
          <option value="dutch">Dutch oven (litres)</option>
        </select>
      </div>
      {p.shape === "round" && (
        <div><span style={lab}>Diameter (cm)</span><input type="number" min="1" value={p.diameter || ""} onChange={(e) => set("diameter", num(e.target.value))} style={box} /></div>
      )}
      {p.shape === "bundt" && (
        <div><span style={lab}>Capacity (cups)</span><input type="number" min="1" step="0.5" value={p.cups || ""} onChange={(e) => set("cups", num(e.target.value))} style={box} /></div>
      )}
      {p.shape === "dutch" && (
        <div><span style={lab}>Capacity (litres)</span><input type="number" min="1" step="0.5" value={p.litres || ""} onChange={(e) => set("litres", num(e.target.value))} style={box} /></div>
      )}
      {p.shape === "square" && (
        <div><span style={lab}>Side (cm)</span><input type="number" min="1" value={p.side || ""} onChange={(e) => set("side", num(e.target.value))} style={box} /></div>
      )}
      {(p.shape === "rectangle" || p.shape === "loaf") && (
        <>
          <div><span style={lab}>Length (cm)</span><input type="number" min="1" value={p.length || ""} onChange={(e) => set("length", num(e.target.value))} style={box} /></div>
          <div><span style={lab}>Width (cm)</span><input type="number" min="1" value={p.width || ""} onChange={(e) => set("width", num(e.target.value))} style={box} /></div>
        </>
      )}
      <div><span style={lab}>How many</span><input type="number" min="1" max="6" value={p.quantity || 1} onChange={(e) => set("quantity", num(e.target.value))} style={box} /></div>
    </div>
  );
}

function SimilarRecipes({ recipe, recipes, favIds, open }) {
  const ingSet = new Set(
    recipe.ingredients.map((i) => canonicalItemName(i.name).toLowerCase()).filter((n) => n.length > 2)
  );

  const scored = recipes
    .filter((r) => r.id !== recipe.id)
    .map((r) => {
      let score = 0;
      const reasons = [];
      const shared = r.ingredients.filter((i) => ingSet.has(canonicalItemName(i.name).toLowerCase())).length;
      if (r.category && r.category === recipe.category) { score += 3; reasons.push(`also in ${r.category}`); }
      score += Math.min(shared, 8) * 0.5;
      if (shared >= 4) reasons.push(`shares ${shared} ingredients`);
      if ((r.rating || 0) >= 4) { score += 2; reasons.push(`you rated it ${"★".repeat(r.rating)}`); }
      if (favIds.includes(r.id)) { score += 1.5; reasons.push("one of your favourites"); }
      if (scalingKind(r) === scalingKind(recipe)) score += 0.5;
      if (!(r.cooked || []).length) score += 0.5;
      return { r, score, reasons };
    })
    .filter((x) => x.score >= 3.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (!scored.length || !open) return null;

  const liked = (recipe.rating || 0) >= 4 || favIds.includes(recipe.id);

  return (
    <div style={{ marginTop: 22 }}>
      <h2 style={{ ...sectionHead(), marginBottom: 10 }}>
        {liked ? "Liked this? You'll probably like…" : "You might also like"}
      </h2>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {scored.map(({ r, reasons }) => (
          <button
            key={r.id}
            onClick={() => { open(r.id); window.scrollTo({ top: 0 }); }}
            style={{
              textAlign: "left", background: C.card, border: `1px solid ${C.line}`,
              borderRadius: 12, padding: 0, overflow: "hidden", display: "flex", flexDirection: "column",
            }}
          >
            {r.photo && <img src={r.photo} alt="" style={{ width: "100%", height: 84, objectFit: "cover", display: "block" }} />}
            <div style={{ padding: "11px 14px 12px" }}>
              <div style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 600, fontSize: 15.5, lineHeight: 1.25 }}>
                {r.title}
                {(r.rating || 0) > 0 && <span style={{ color: C.mustard, fontSize: 12, marginLeft: 6, letterSpacing: 1 }}>{"★".repeat(r.rating)}</span>}
              </div>
              <div style={{ fontSize: 12, color: C.inkSoft, marginTop: 4, lineHeight: 1.45 }}>
                {reasons.slice(0, 2).join(" · ") || "a close cousin of this one"}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Stars({ value, onChange }) {
  return (
    <span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          onClick={() => onChange(n)}
          aria-label={`Rate ${n} star${n > 1 ? "s" : ""}`}
          style={{ background: "none", border: "none", padding: "2px 1px", fontSize: 19, lineHeight: 1, color: n <= value ? C.mustard : C.faint }}
        >
          {n <= value ? "★" : "☆"}
        </button>
      ))}
    </span>
  );
}

const sectionHead = () => ({
  fontFamily: "'Bricolage Grotesque'",
  fontWeight: 600, fontSize: 13, letterSpacing: 1.4, textTransform: "uppercase",
  color: C.headMut, margin: "0 0 8px",
});

function Stepper({ label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label === "+" ? "Increase servings" : "Decrease servings"}
      style={{
        width: 46, height: 46, borderRadius: "50%", border: "none",
        background: disabled ? C.onPrimaryFaint2 : C.onPrimary,
        color: disabled ? C.onPrimaryFaint : C.greenDeep,
        fontSize: 24, fontWeight: 700, lineHeight: 1,
      }}
    >
      {label}
    </button>
  );
}

/* ---------- weekly planner ---------- */

function PlannerPage({ plan, recipes, settings, bakePlans, setBakePlans, sendBakePlanToShop, onToast, templates, onSaveTemplate, onApplyTemplate, onDeleteTemplate, setEntryServings, removeEntry, addEntry, clearWeek, addWeekToShop, openRecipe }) {
  const [mode, setMode] = useState("dinner"); // dinner | bake
  const [addingDay, setAddingDay] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplName, setTplName] = useState("");
  const total = DAYS.reduce((a, d) => a + plan[d].length, 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {[["dinner", `Dinner planner${total ? ` · ${total}` : ""}`], ["bake", `Bake planner${bakePlans.length ? ` · ${bakePlans.length}` : ""}`]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            style={{
              border: `1px solid ${mode === id ? C.green : C.line}`,
              background: mode === id ? C.green : C.card,
              color: mode === id ? C.onPrimary : C.inkSoft,
              borderRadius: 999, padding: "9px 20px", fontSize: 14, fontWeight: 600,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "bake" && (
        <BakePlanner
          recipes={recipes}
          plans={bakePlans}
          setPlans={setBakePlans}
          sendToShop={sendBakePlanToShop}
          onToast={onToast}
          openRecipe={openRecipe}
        />
      )}

      {mode === "dinner" && (
      <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 28, margin: 0 }}>This week</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={addWeekToShop}
            disabled={!total}
            style={{ background: total ? C.mustard : C.line, color: total ? C.onAccent : C.disabledText, border: "none", borderRadius: 999, padding: "9px 18px", fontWeight: 600, fontSize: 13.5, cursor: total ? "pointer" : "default" }}
          >
            Send week to shopping list
          </button>
          {total > 0 && (!confirmClear ? (
            <button onClick={() => setConfirmClear(true)} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 999, padding: "9px 16px", fontSize: 13, color: C.danger, fontWeight: 500 }}>Clear week</button>
          ) : (
            <button onClick={() => { clearWeek(); setConfirmClear(false); }} style={{ background: C.danger, border: "none", color: "#fff", borderRadius: 999, padding: "9px 16px", fontSize: 13, fontWeight: 600 }}>Confirm clear</button>
          ))}
        </div>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 16px", marginBottom: 16 }}>
        <div style={{ ...sectionHead(), marginBottom: 8 }}>Week templates</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {templates.map((t) => (
            <span key={t.id} style={{ display: "inline-flex", alignItems: "center", border: `1px solid ${C.line}`, borderRadius: 999, background: C.bg, overflow: "hidden" }}>
              <button
                onClick={() => onApplyTemplate(t)}
                title="Apply this template to the week"
                style={{ background: "none", border: "none", padding: "7px 6px 7px 14px", fontSize: 13, fontWeight: 600, color: C.ink }}
              >
                {t.name}
              </button>
              <button
                onClick={() => onDeleteTemplate(t.id)}
                aria-label={`Delete template ${t.name}`}
                style={{ background: "none", border: "none", padding: "7px 10px 7px 4px", fontSize: 14, color: C.faint }}
              >
                ×
              </button>
            </span>
          ))}
          {!savingTpl ? (
            <button
              onClick={() => setSavingTpl(true)}
              disabled={!total}
              style={{ background: "none", border: `1px dashed ${C.line}`, borderRadius: 999, padding: "7px 14px", fontSize: 13, color: total ? C.inkSoft : C.disabledText, fontWeight: 500, cursor: total ? "pointer" : "default" }}
            >
              + Save this week as a template
            </button>
          ) : (
            <span style={{ display: "inline-flex", gap: 6 }}>
              <input
                autoFocus
                value={tplName}
                onChange={(e) => setTplName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && tplName.trim()) { onSaveTemplate(tplName.trim()); setTplName(""); setSavingTpl(false); } }}
                placeholder="e.g. Normal week"
                style={{ padding: "7px 12px", borderRadius: 999, border: `1px solid ${C.line}`, background: C.bg, fontSize: 13, width: 150 }}
              />
              <button
                onClick={() => { if (tplName.trim()) { onSaveTemplate(tplName.trim()); setTplName(""); setSavingTpl(false); } }}
                style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "7px 14px", fontSize: 13, fontWeight: 600 }}
              >
                Save
              </button>
              <button onClick={() => { setSavingTpl(false); setTplName(""); }} style={{ background: "none", border: "none", color: C.inkSoft, fontSize: 13 }}>Cancel</button>
            </span>
          )}
        </div>
        {templates.length > 0 && (
          <div style={{ fontSize: 12, color: C.faint, marginTop: 8 }}>Tap a template to apply it — it replaces whatever's currently planned.</div>
        )}
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {DAYS.map((day) => (
          <div key={day} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: plan[day].length || addingDay === day ? 10 : 0 }}>
              <div style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 600, fontSize: 16 }}>{day}</div>
              <button
                onClick={() => setAddingDay(addingDay === day ? null : day)}
                style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 999, padding: "5px 13px", fontSize: 12.5, color: C.inkSoft, fontWeight: 500 }}
              >
                {addingDay === day ? "Cancel" : "+ Add meal"}
              </button>
            </div>

            {addingDay === day && (
              <DayRecipePicker
                recipes={recipes}
                defaultServes={settings.defaultServes}
                onPick={(recipeId, servings) => { addEntry(day, recipeId, servings); setAddingDay(null); }}
              />
            )}

            {plan[day].map((e) => {
              const r = recipes.find((x) => x.id === e.recipeId);
              if (!r) return null;
              const kind = scalingKind(r);
              return (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: `1px solid ${C.line}`, flexWrap: "wrap" }}>
                  <button onClick={() => openRecipe(r.id)} style={{ background: "none", border: "none", padding: 0, fontSize: 15, fontWeight: 600, color: e.leftover ? C.inkSoft : C.ink, textAlign: "left", flex: "1 1 160px" }}>
                    {e.leftover ? "🍲 " : ""}{r.title}
                    {e.leftover && <span style={{ display: "block", fontSize: 11.5, fontWeight: 500, color: C.faint, marginTop: 1 }}>Leftovers — already on the shopping list from the night it's cooked</span>}
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {kind !== "pan" && <MiniStep label="−" disabled={e.servings <= 1} onClick={() => setEntryServings(day, e.id, -1)} />}
                    <span style={{ fontSize: 13.5, color: C.inkSoft, minWidth: 64, textAlign: "center" }}>
                      {kind === "serves"
                        ? `serves ${e.servings}`
                        : kind === "batch"
                          ? `×${fmtFactor(e.servings)} batch`
                          : Math.abs(e.servings - 1) < 0.001 ? "as written" : `×${Math.round(e.servings * 100) / 100}`}
                    </span>
                    {kind !== "pan" && <MiniStep label="+" disabled={e.servings >= 40} onClick={() => setEntryServings(day, e.id, 1)} />}
                    <button onClick={() => removeEntry(day, e.id)} aria-label="Remove meal" style={{ background: "none", border: "none", color: C.danger, fontSize: 16, padding: "4px 8px" }}>×</button>
                  </div>
                </div>
              );
            })}
            <LeftoverSuggestions
              day={day}
              plan={plan}
              recipes={recipes}
              household={settings.defaultServes}
              addEntry={addEntry}
            />

            {!plan[day].length && addingDay !== day && (
              <div style={{ fontSize: 13, color: C.faint, marginTop: 2 }}>Nothing planned</div>
            )}
          </div>
        ))}
      </div>
      {!settings.defaultServes && total > 0 && (
        <div style={{ fontSize: 12.5, color: C.faint, marginTop: 12, lineHeight: 1.5 }}>
          Tip: set your household serves in Settings and the planner will spot when a meal makes enough for a leftovers night.
        </div>
      )}
      </>
      )}
    </div>
  );
}

function LeftoverSuggestions({ day, plan, recipes, household, addEntry }) {
  if (!household) return null;
  const di = DAYS.indexOf(day);
  if (di <= 0) return null;
  const prevDay = DAYS[di - 1];

  const suggestions = plan[prevDay]
    .filter((e) => !e.leftover)
    .map((e) => ({ e, r: recipes.find((x) => x.id === e.recipeId) }))
    .filter(({ e, r }) => r && scalingKind(r) === "serves" && e.servings - household >= 1)
    .map(({ e, r }) => ({ r, spare: e.servings - household }))
    .filter(({ r }) => !plan[day].some((x) => x.leftover && x.recipeId === r.id));

  if (!suggestions.length) return null;

  return (
    <div style={{ marginTop: plan[day].length ? 6 : 2 }}>
      {suggestions.map(({ r, spare }) => (
        <button
          key={r.id}
          onClick={() => addEntry(day, r.id, spare, true)}
          style={{
            display: "block", width: "100%", textAlign: "left",
            background: C.mustardSoft, border: `1px dashed ${C.mustard}`,
            borderRadius: 10, padding: "8px 12px", marginTop: 6,
            fontSize: 13, color: C.accentText, lineHeight: 1.45,
          }}
        >
          🍲 <strong>{prevDay}'s {r.title}</strong> makes {spare} spare serve{spare > 1 ? "s" : ""} for your household of {household} — tap to plan leftovers tonight
        </button>
      ))}
    </div>
  );
}

/* ---------- bake planner (ported from the Bakehouse) ---------- */

function BakePlanner({ recipes, plans, setPlans, sendToShop, onToast, openRecipe }) {
  const [draft, setDraft] = useState({ name: "", date: "", time: "" });
  const [pickerFor, setPickerFor] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);

  const sorted = [...plans].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const fmtDate = (d) => {
    try { return new Date(d + "T00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }); }
    catch { return d; }
  };
  const update = (id, patch) => setPlans(plans.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  return (
    <div>
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px", marginBottom: 16 }}>
        <div style={{ ...sectionHead(), marginBottom: 8 }}>Plan a bake</div>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="What's the occasion? e.g. Morning tea for the team"
          style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, marginBottom: 10, fontSize: 14 }}
        />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ fontSize: 12, color: C.inkSoft }}>Date<br />
            <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} style={{ marginTop: 4, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, fontSize: 14 }} />
          </label>
          <label style={{ fontSize: 12, color: C.inkSoft }}>Serving at (optional)<br />
            <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} style={{ marginTop: 4, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, fontSize: 14 }} />
          </label>
          <button
            disabled={!draft.date}
            onClick={() => {
              setPlans([...plans, { id: uid(), name: draft.name.trim() || "Bake day", date: draft.date, serveTime: draft.time, entries: [] }]);
              setDraft({ name: "", date: "", time: "" });
              onToast("Bake plan created");
            }}
            style={{ background: draft.date ? C.green : C.line, color: draft.date ? C.onPrimary : C.disabledText, border: "none", borderRadius: 999, padding: "10px 20px", fontSize: 13.5, fontWeight: 600, cursor: draft.date ? "pointer" : "default" }}
          >
            Create plan
          </button>
        </div>
      </div>

      {!sorted.length && (
        <div style={{ color: C.inkSoft, textAlign: "center", padding: "40px 20px", background: C.card, border: `1px dashed ${C.line}`, borderRadius: 14, lineHeight: 1.6, fontSize: 14 }}>
          No bakes planned yet — create one above, attach recipes with a batch multiplier, and send the combined ingredients to the shopping list. With a serving time set, each bake gets a "start by" time.
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {sorted.map((pl) => {
          const entries = pl.entries.map((e) => ({ e, r: recipes.find((x) => x.id === e.recipeId) })).filter((x) => x.r);
          return (
            <div key={pl.id} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
                <div style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17 }}>{pl.name}</div>
                <span style={{ fontSize: 12.5, color: C.inkSoft, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: "3px 11px" }}>
                  {fmtDate(pl.date)}{pl.serveTime ? ` · serving ${pl.serveTime}` : ""}
                </span>
              </div>

              <label style={{ fontSize: 12, color: C.inkSoft }}>Serving at (drives each bake's "start by")<br />
                <input type="time" value={pl.serveTime || ""} onChange={(e) => update(pl.id, { serveTime: e.target.value })} style={{ marginTop: 4, marginBottom: 6, padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.bg, fontSize: 14 }} />
              </label>

              {entries.map(({ e, r }) => {
                const t = totalMinutesFor(r);
                let startBy = null;
                if (t && pl.serveTime) {
                  const dt = new Date(pl.date + "T" + pl.serveTime);
                  if (!isNaN(dt)) startBy = new Date(dt.getTime() - t * 60000).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
                }
                return (
                  <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: `1px solid ${C.line}`, flexWrap: "wrap" }}>
                    <button onClick={() => openRecipe(r.id)} style={{ background: "none", border: "none", padding: 0, textAlign: "left", flex: "1 1 170px", color: C.ink }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{r.title}</span>
                      {t && (
                        <span style={{ display: "block", fontSize: 11.5, color: C.inkSoft, marginTop: 1 }}>
                          {fmtDur(t)} start to serve{startBy ? ` · ⏰ start by ${startBy}` : ""}
                        </span>
                      )}
                    </button>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <select
                        value={e.factor}
                        onChange={(ev) => update(pl.id, { entries: pl.entries.map((x) => (x.id === e.id ? { ...x, factor: Number(ev.target.value) } : x)) })}
                        style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.bg, fontSize: 13 }}
                      >
                        {BATCH_OPTIONS.map((m) => <option key={m} value={m}>×{fmtFactor(m)}</option>)}
                      </select>
                      <button
                        onClick={() => update(pl.id, { entries: pl.entries.filter((x) => x.id !== e.id) })}
                        aria-label="Remove bake"
                        style={{ background: "none", border: "none", color: C.danger, fontSize: 16, padding: "4px 8px" }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}

              {pickerFor === pl.id ? (
                <div style={{ marginTop: 8 }}>
                  <DayRecipePicker
                    recipes={recipes}
                    defaultServes={null}
                    onPick={(recipeId) => {
                      update(pl.id, { entries: [...pl.entries, { id: uid(), recipeId, factor: 1 }] });
                      setPickerFor(null);
                    }}
                  />
                </div>
              ) : (
                <button
                  onClick={() => setPickerFor(pl.id)}
                  style={{ marginTop: 8, background: "none", border: `1px dashed ${C.line}`, borderRadius: 999, padding: "6px 14px", fontSize: 12.5, color: C.inkSoft, fontWeight: 500 }}
                >
                  + Add a recipe
                </button>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button
                  onClick={() => sendToShop(pl)}
                  disabled={!entries.length}
                  style={{ background: entries.length ? C.mustard : C.line, color: entries.length ? C.onAccent : C.disabledText, border: "none", borderRadius: 999, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: entries.length ? "pointer" : "default" }}
                >
                  Send ingredients to shopping list
                </button>
                {confirmDel !== pl.id ? (
                  <button onClick={() => setConfirmDel(pl.id)} style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: "8px 16px", fontSize: 13, color: C.danger, fontWeight: 500 }}>Delete plan</button>
                ) : (
                  <button onClick={() => { setPlans(plans.filter((p) => p.id !== pl.id)); setConfirmDel(null); }} style={{ background: C.danger, border: "none", color: "#fff", borderRadius: 999, padding: "8px 16px", fontSize: 13, fontWeight: 600 }}>Confirm delete</button>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: C.faint, marginTop: 8 }}>
                Set × per bake and the shopping list gets multiplied quantities. For pan-specific scaling, open the recipe itself.
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayRecipePicker({ recipes, defaultServes, onPick }) {
  const [q, setQ] = useState("");
  const matches = recipes
    .filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.title.localeCompare(b.title));
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 10, marginBottom: 10, background: C.bg }}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search your ${recipes.length} recipes`}
        style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, marginBottom: 8 }}
      />
      <div style={{ maxHeight: 280, overflowY: "auto", overscrollBehavior: "contain" }}>
      {matches.map((r) => {
        const c = r.cooked || [];
        return (
          <button
            key={r.id}
            onClick={() => onPick(r.id, scalingKind(r) === "serves" ? (defaultServes || r.baseServings) : 1)}
            style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "7px 4px", fontSize: 14, borderRadius: 6 }}
          >
            <span style={{ fontWeight: 600 }}>{r.title}</span>
            <span style={{ color: C.inkSoft, fontSize: 12.5 }}>
              {" "}· {scalingKind(r) === "serves" ? `serves ${r.baseServings}` : scalingKind(r) === "pan" ? panLabel(r.basePan) : (r.yield || "batch")}
              {c.length ? ` · last made ${timeAgo(c[c.length - 1])}` : " · not cooked yet"}
            </span>
          </button>
        );
      })}
      {!matches.length && <div style={{ fontSize: 13, color: C.inkSoft, padding: 4 }}>No matches</div>}
      </div>
    </div>
  );
}

function MiniStep({ label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label === "+" ? "Increase servings" : "Decrease servings"}
      style={{
        width: 28, height: 28, borderRadius: "50%", border: `1px solid ${C.line}`,
        background: disabled ? C.bg : C.card, color: disabled ? C.faint : C.ink,
        fontSize: 15, fontWeight: 700, lineHeight: 1,
      }}
    >
      {label}
    </button>
  );
}

/* ---------- shopping list ---------- */

function ShoppingPage({ items, toggle, remove, addManual, clearChecked, clearAll, onToast }) {
  const [text, setText] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const open = items.filter((i) => !i.checked);
  const done = items.filter((i) => i.checked);

  const grouped = AISLES.map(([label]) => [label, open.filter((i) => aisleFor(i.name) === label)]).filter(([, g]) => g.length);

  const submit = () => {
    if (!text.trim()) return;
    addManual(text);
    setText("");
  };

  const shareList = async () => {
    if (!open.length) { onToast("Nothing on the list yet"); return; }
    const body = grouped
      .map(([label, g]) => `${label}:\n` + g.map((i) => `- ${i.amount != null ? formatAmount(i.amount, i.unit) + (i.unit ? " " + i.unit : "") + " " : ""}${i.name}`).join("\n"))
      .join("\n\n");
    const payload = `The Kitchen shopping list\n\n${body}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Shopping list", text: payload });
      } else {
        await navigator.clipboard.writeText(payload);
        onToast("List copied — paste it anywhere (Reminders, Notes, a text)");
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
      try { await navigator.clipboard.writeText(payload); onToast("List copied to clipboard"); } catch { onToast("Couldn't share on this device"); }
    }
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 28, margin: 0 }}>Shopping list</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {open.length > 0 && (
            <button onClick={shareList} style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "8px 16px", fontSize: 13, fontWeight: 600 }}>
              Share list
            </button>
          )}
          {done.length > 0 && (
            <button onClick={clearChecked} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 999, padding: "8px 15px", fontSize: 13, fontWeight: 500 }}>
              Clear ticked · {done.length}
            </button>
          )}
          {items.length > 0 && (!confirmClear ? (
            <button onClick={() => setConfirmClear(true)} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 999, padding: "8px 15px", fontSize: 13, color: C.danger, fontWeight: 500 }}>Clear all</button>
          ) : (
            <button onClick={() => { clearAll(); setConfirmClear(false); }} style={{ background: C.danger, border: "none", color: "#fff", borderRadius: 999, padding: "8px 15px", fontSize: 13, fontWeight: 600 }}>Confirm clear</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder='Add an item — e.g. "2 l milk" or "dog treats for Fred"'
          style={{ flex: 1, padding: "11px 15px", borderRadius: 12, border: `1px solid ${C.line}`, background: C.card }}
        />
        <button onClick={submit} style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 12, padding: "0 20px", fontWeight: 600, fontSize: 14 }}>
          Add
        </button>
      </div>

      {!items.length && (
        <div style={{ color: C.inkSoft, textAlign: "center", padding: "50px 20px", background: C.card, border: `1px dashed ${C.line}`, borderRadius: 14, lineHeight: 1.6, fontSize: 14 }}>
          Your list is empty. Add items above, use “Add to shopping list” on any recipe, or send a whole week over from the planner. Duplicate ingredients merge automatically, and everything is grouped by supermarket aisle.
        </div>
      )}

      {grouped.map(([label, g]) => (
        <div key={label} style={{ marginBottom: 16 }}>
          <div style={{ ...sectionHead(), marginBottom: 6 }}>{label}</div>
          {g.map((i) => <ShopRow key={i.id} item={i} toggle={toggle} remove={remove} />)}
        </div>
      ))}

      {done.length > 0 && (
        <>
          <div style={{ ...sectionHead(), marginTop: 24, marginBottom: 6 }}>In the trolley</div>
          {done.map((i) => <ShopRow key={i.id} item={i} toggle={toggle} remove={remove} />)}
        </>
      )}
    </div>
  );
}

function ShopRow({ item, toggle, remove }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 14px", marginBottom: 8, opacity: item.checked ? 0.55 : 1 }}>
      <button
        onClick={() => toggle(item.id)}
        aria-label={item.checked ? "Untick item" : "Tick item"}
        style={{
          width: 24, height: 24, borderRadius: 7, flexShrink: 0,
          border: `2px solid ${item.checked ? C.green : C.line}`,
          background: item.checked ? C.green : "transparent",
          color: C.onPrimary, fontSize: 14, lineHeight: 1, display: "grid", placeItems: "center",
        }}
      >
        {item.checked ? "✓" : ""}
      </button>
      <span style={{ flex: 1, fontSize: 15, textDecoration: item.checked ? "line-through" : "none" }}>
        {item.amount != null && (
          <strong style={{ fontWeight: 600 }}>{formatAmount(item.amount, item.unit)}{item.unit ? ` ${item.unit}` : ""} </strong>
        )}
        {item.name}
      </span>
      <button onClick={() => remove(item.id)} aria-label="Remove item" style={{ background: "none", border: "none", color: C.faint, fontSize: 17, padding: 4 }}>×</button>
    </div>
  );
}

/* ---------- add / edit recipe ---------- */

function EditPage({ recipe, settings, onCancel, onSave }) {
  const [title, setTitle] = useState(recipe?.title || "");
  const [category, setCategory] = useState(recipe?.category || "Weeknight");
  const [time, setTime] = useState(recipe?.time || "");
  const [servings, setServingsField] = useState(recipe?.baseServings || settings.defaultServes || 4);
  const [skill, setSkill] = useState(recipe?.skill || "");
  const [ingText, setIngText] = useState(
    recipe ? recipe.ingredients.map((i) => (i.amount != null ? `${trimNum(i.amount)}${i.unit ? " " + i.unit : ""} ${i.name}` : i.name)).join("\n") : ""
  );
  const [stepText, setStepText] = useState(recipe ? recipe.steps.join("\n") : "");
  const [notes, setNotes] = useState(recipe?.notes || "");
  const [photo, setPhoto] = useState(recipe?.photo || "");
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteMsg, setPasteMsg] = useState("");
  const [convOpen, setConvOpen] = useState(false);
  const [convItem, setConvItem] = useState("Plain / SR flour");
  const [convMeasure, setConvMeasure] = useState(250);

  const runImport = () => {
    const p = parsePastedRecipe(pasteText);
    if (!p.ingLines.length && !p.stepLines.length) {
      setPasteMsg("Couldn't find ingredients or steps in that text — check it has one item per line.");
      return;
    }
    if (p.title && !title) setTitle(p.title);
    if (p.serves) setServingsField(p.serves);
    if (p.ingLines.length) setIngText(p.ingLines.join("\n"));
    if (p.stepLines.length) setStepText(p.stepLines.join("\n"));
    setPasteMsg(`Filled in ${p.ingLines.length} ingredients and ${p.stepLines.length} steps — check them over below, then save.`);
  };

  const handlePhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try { setPhoto(await resizeImage(file, 700)); }
    catch { setError("Couldn't read that image."); }
    e.target.value = "";
  };

  const submit = () => {
    const ingredients = ingText.split("\n").map(parseIngredientLine).filter(Boolean);
    const steps = stepText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!title.trim()) return setError("Give the recipe a name.");
    if (!ingredients.length) return setError("Add at least one ingredient.");
    if (!steps.length) return setError("Add at least one method step.");
    onSave({
      id: recipe?.id || uid(),
      title: title.trim(),
      category,
      time: time.trim(),
      baseServings: Math.max(1, parseInt(servings, 10) || 1),
      ingredients,
      steps,
      notes: notes.trim(),
      photo,
      rating: recipe?.rating || 0,
      cooked: recipe?.cooked || [],
      ...(skill ? { skill } : {}),
      ...(recipe?.scaling ? { scaling: recipe.scaling } : {}),
      ...(recipe?.basePan ? { basePan: recipe.basePan } : {}),
      ...(recipe?.temp ? { temp: recipe.temp } : {}),
      ...(recipe?.yield ? { yield: recipe.yield } : {}),
    });
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 28, margin: "0 0 14px" }}>
        {recipe ? "Edit recipe" : "New recipe"}
      </h1>

      <div style={{ marginBottom: 18 }}>
        {!pasteOpen ? (
          <button
            onClick={() => setPasteOpen(true)}
            style={{ background: C.card, border: `1px dashed ${C.line}`, borderRadius: 12, padding: "10px 16px", fontSize: 13.5, color: C.inkSoft, fontWeight: 500 }}
          >
            📋 Paste a recipe from anywhere…
          </button>
        ) : (
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px" }}>
            <div style={{ fontSize: 13, color: C.inkSoft, marginBottom: 8, lineHeight: 1.5 }}>
              Copy a recipe from a website or note and paste it here — I'll pull out the title, serves, ingredients and steps for you to tidy up.
            </div>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={6}
              placeholder={"Honey Soy Chicken\nServes 4\n\nIngredients\n500 g chicken thighs\n2 tbsp honey\n\nMethod\n1. Mix the marinade…"}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, resize: "vertical", lineHeight: 1.6, marginBottom: 8 }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={runImport} style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "8px 18px", fontSize: 13.5, fontWeight: 600 }}>
                Fill in the form
              </button>
              <button onClick={() => { setPasteOpen(false); setPasteMsg(""); }} style={{ background: "none", border: "none", color: C.inkSoft, fontSize: 13 }}>Close</button>
            </div>
            {pasteMsg && <div style={{ fontSize: 13, color: C.green, marginTop: 8, fontWeight: 500 }}>{pasteMsg}</div>}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 18 }}>
        {!convOpen ? (
          <button
            onClick={() => setConvOpen(true)}
            style={{ background: C.card, border: `1px dashed ${C.line}`, borderRadius: 12, padding: "10px 16px", fontSize: 13.5, color: C.inkSoft, fontWeight: 500 }}
          >
            ⚖️ Cups & spoons converter (AU standard)…
          </button>
        ) : (
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ ...sectionHead(), margin: 0 }}>Cups & spoons converter (AU standard)</span>
              <button onClick={() => setConvOpen(false)} style={{ background: "none", border: "none", color: C.inkSoft, fontSize: 13 }}>Close</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 10 }}>
              <label style={{ fontSize: 12, color: C.inkSoft }}>Ingredient<br />
                <select value={convItem} onChange={(e) => setConvItem(e.target.value)} style={{ ...inputStyle(), marginTop: 4 }}>
                  {Object.keys(CUP_TABLE).map((k) => <option key={k}>{k}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, color: C.inkSoft }}>Measure<br />
                <select value={convMeasure} onChange={(e) => setConvMeasure(Number(e.target.value))} style={{ ...inputStyle(), marginTop: 4 }}>
                  {MEASURES.map(([label, ml]) => <option key={label} value={ml}>{label}</option>)}
                </select>
              </label>
            </div>
            <div style={{ background: C.mustardSoft, borderRadius: 10, padding: "12px 14px", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 26, color: C.accentText, lineHeight: 1.1 }}>
                  {Math.round(CUP_TABLE[convItem] * (convMeasure / 250))} g
                </div>
                <div style={{ fontSize: 13, color: C.accentText, fontWeight: 600 }}>{trimNum(convMeasure)} ml</div>
              </div>
              <div style={{ flex: 1, fontSize: 12.5, color: C.noteText, lineHeight: 1.5, minWidth: 180 }}>
                {MEASURES.find(([, ml]) => ml === convMeasure)?.[0]} of {convItem.toLowerCase()} · °F to °C ≈ (°F − 32) ÷ 1.8, then − 20°C for fan-forced.
              </div>
            </div>
          </div>
        )}
      </div>

      <Field label="Photo (optional)">
        {photo ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img src={photo} alt="Recipe" style={{ width: 110, height: 78, objectFit: "cover", borderRadius: 10, border: `1px solid ${C.line}` }} />
            <label style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 999, padding: "8px 16px", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
              Replace
              <input type="file" accept="image/*" onChange={handlePhoto} style={{ display: "none" }} />
            </label>
            <button onClick={() => setPhoto("")} style={{ background: "none", border: "none", color: C.danger, fontSize: 13, fontWeight: 500 }}>Remove</button>
          </div>
        ) : (
          <label style={{ display: "inline-block", background: C.card, border: `1px dashed ${C.line}`, borderRadius: 12, padding: "10px 18px", fontSize: 13.5, color: C.inkSoft, cursor: "pointer" }}>
            📷 Add a photo of the finished dish
            <input type="file" accept="image/*" onChange={handlePhoto} style={{ display: "none" }} />
          </label>
        )}
      </Field>

      <Field label="Recipe name">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Honey soy chicken" style={inputStyle()} />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle()}>
            {(CATEGORIES.includes(category) ? CATEGORIES : [category, ...CATEGORIES]).map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Serves">
          <input type="number" min="1" max="40" value={servings} onChange={(e) => setServingsField(e.target.value)} style={inputStyle()} />
        </Field>
        <Field label="Time (optional)">
          <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="e.g. 30 min" style={inputStyle()} />
        </Field>
        <Field label="Skill level">
          <select value={skill} onChange={(e) => setSkill(e.target.value)} style={inputStyle()}>
            <option value="">Auto — worked out from the method</option>
            {SKILL_LEVELS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Ingredients — one per line" hint={'Start each line with the amount and unit, e.g. "500 g beef mince" or "2 tbsp soy sauce". Lines without an amount (like "salt, to taste") won\u2019t scale.'}>
        <textarea value={ingText} onChange={(e) => setIngText(e.target.value)} rows={9} placeholder={"500 g chicken thigh fillets\n2 tbsp honey\n1 tbsp soy sauce\nsalt and pepper, to taste"} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6 }} />
      </Field>

      <Field label="Method — one step per line">
        <textarea value={stepText} onChange={(e) => setStepText(e.target.value)} rows={7} placeholder={"Preheat a fan-forced oven to 180°C.\nMix the marinade ingredients…"} style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6 }} />
      </Field>

      <Field label="Notes (optional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Freezes well, swap suggestions, etc." style={inputStyle()} />
      </Field>

      {error && <div style={{ color: C.danger, fontSize: 14, marginBottom: 12, fontWeight: 500 }}>{error}</div>}

      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={submit} style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "12px 26px", fontWeight: 600, fontSize: 15 }}>
          Save recipe
        </button>
        <button onClick={onCancel} style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 999, padding: "12px 22px", fontSize: 15, color: C.inkSoft }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: "block", marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: C.ink }}>{label}</div>
      {hint && <div style={{ fontSize: 12.5, color: C.inkSoft, marginBottom: 6, lineHeight: 1.5 }}>{hint}</div>}
      {children}
    </label>
  );
}

const inputStyle = () => ({
  width: "100%", padding: "10px 14px", borderRadius: 10,
  border: `1px solid ${C.line}`, background: C.card,
});


/* ---------- oven adjustment ---------- */

function applyOven(text, oven) {
  if (oven !== "conventional") return text;
  return text.replace(/(\d{2,3})\s*°C/g, (m, t) => `${parseInt(t, 10) + 20}°C`);
}

/* ---------- cooking tips ---------- */

const TIPS = [
  {
    group: "Scaling up and down",
    intro: "The scaler does the maths, but a few things don't scale in a straight line.",
    tips: [
      "Spices, chilli and strong aromatics don't double neatly. When doubling a recipe, start with about 1.5× the spice and adjust at the end.",
      "Salt scales less than linearly too — season a doubled batch to about 1.5–1.75×, then taste.",
      "Cooking times mostly don't change with servings. A bigger pot takes longer to come to the boil, but simmer and roast times stay roughly the same — cook to doneness, not the clock.",
      "When doubling mince or diced meat, brown it in batches. A crowded pan steams instead of browning and you lose the flavour that makes the dish.",
      "Scaling down? Sauces reduce faster in a small batch — check earlier and keep a splash of stock or pasta water handy to loosen.",
    ],
  },
  {
    group: "Before you start",
    tips: [
      "Read the whole method before you turn anything on. The moment you discover the marinade needed 30 minutes is not the moment to discover it.",
      "Mise en place is the whole game on high heat: for stir-fries and pan sauces, have everything chopped, measured and within reach before the pan is hot.",
      "A sharp knife is safer than a blunt one — a quick pass on a honing steel before you start makes every prep job faster.",
      "Preheat properly. A fan-forced oven usually needs 10–15 minutes to be genuinely at temperature, not just claiming it.",
    ],
  },
  {
    group: "Seasoning",
    tips: [
      "Season in layers as you cook, not just at the end — salt added early gets into the food; salt added late sits on top.",
      "If a dish tastes flat and more salt isn't fixing it, it usually wants acid: a squeeze of lemon or lime, or a splash of vinegar right at the end.",
      "Salt your pasta water like you mean it — about 1 tbsp per 2 litres. It's the only chance to season the pasta itself.",
      "Taste before you serve, every time. It's the cheapest quality control there is.",
    ],
  },
  {
    group: "Meat and heat",
    tips: [
      "Take meat out of the fridge 20–30 minutes before cooking so it cooks evenly instead of overdone outside, cold inside.",
      "Pat meat dry with paper towel before searing — a wet surface steams, a dry one browns.",
      "Don't move it too soon. Meat releases from the pan when it's ready; if it's sticking, it isn't seared yet.",
      "Rest roasted and grilled meat for at least 5–10 minutes before carving — the juices redistribute instead of ending up on the board.",
    ],
  },
  {
    group: "Pasta, rice and sauces",
    tips: [
      "Save a mug of pasta cooking water before you drain. Its starch is what turns sauce and pasta into one glossy thing instead of two separate ones.",
      "Cook pasta 1–2 minutes short of the packet time and finish it in the sauce — it absorbs flavour and lands exactly al dente.",
      "Fried rice wants cold, day-old rice. Fresh rice turns gluggy; plan it as tomorrow's dinner when you cook rice tonight.",
      "Most tomato-based sauces, curries and stews are genuinely better the next day — cook once, eat twice.",
    ],
  },
  {
    group: "Storage and leftovers",
    tips: [
      "Cool food quickly before refrigerating — spread it in a shallow container rather than leaving a big hot pot out for hours.",
      "Freeze flat in zip-lock bags: faster to freeze, faster to thaw, and they stack like files.",
      "Label everything with the name and date. Future-you cannot identify frozen brown cubes.",
      "Most cooked leftovers keep 3 days in the fridge and 2–3 months in the freezer at good quality — the planner is handy for scheduling the encore.",
    ],
  },
];

const TIPS_BAKING = [{"group":"Butter, eggs & ingredients","tips":[["Why room-temperature butter?","Creaming only works when butter is soft enough (about 18–20°C) to trap air — those tiny bubbles are what raising agents inflate in the oven. Cold butter won't aerate; melted butter has no structure to hold bubbles at all, which is why melted-butter cakes are denser."],["Why room-temperature eggs?","They emulsify into creamed butter smoothly instead of shocking the fat and splitting the batter, and whites whip to noticeably more volume. Quick fix: sit eggs in warm tap water for 5 minutes."],["Cold butter for pastry and scones","The opposite rule to cakes: visible chunks of cold butter melt in the oven and release steam, forcing flaky layers apart. If the butter warms and blends in, you get tough, greasy pastry — work fast, chill often."],["Egg sizes matter","Australian recipes (including this app's) assume 59–60 g eggs. If yours are mixed sizes, weigh them: about 50 g of egg out of the shell per 'egg' keeps ratios right."],["Bicarb vs baking powder","Bicarb needs an acid to fire (buttermilk, golden syrup, brown sugar, cocoa) and is roughly 3–4× stronger than baking powder, which carries its own acid. Too much bicarb without acid = soapy, metallic taste."],["Test your raising agents","Bicarb should fizz hard in vinegar; baking powder should fizz in hot water. If the reaction is feeble, bin it — flat cakes are almost always stale raising agents or an unlevel measure."],["Don't skip the salt","A pinch sharpens sweetness and rounds out flavour — sweet things taste flat without it."],["Rub zest into the sugar","Citrus oils live in the coloured skin only (the white pith is bitter). Rubbing zest into sugar with your fingertips before creaming releases far more flavour."],["Melting chocolate without seizing","Gentle heat, and never let a drop of water in — a splash makes melted chocolate seize into a grainy lump. Microwave in 30-second bursts, stirring between, or use a bowl over barely simmering water."],["No buttermilk? Make it","250 ml milk + 1 tablespoon lemon juice or white vinegar, stood for 5 minutes, substitutes perfectly in cakes."],["Sticky ingredients, clean scales","Lightly oil the spoon or bowl before weighing honey or golden syrup and it slides straight off."]]},{"group":"Measuring & mixing","tips":[["Weigh, don't scoop","A 'cup of flour' varies up to 20% depending on how it's packed — enough to wreck a cake. Scales are repeatable every time, which is why every recipe here is in grams."],["The Australian tablespoon trap","An AU tablespoon is 20 ml (4 teaspoons); UK, US and NZ tablespoons are 15 ml. Check where a recipe comes from before measuring spices or raising agents."],["Creaming takes real time","Pale and fluffy means 4–5 minutes in a stand mixer, not 30 seconds. Sugar crystals physically cut air pockets into the butter — that's most of your cake's lift and tenderness."],["Stop mixing once the flour's in","Stirring develops gluten, and gluten makes cake tough and tunnelled. Fold until you can't see dry flour, then put the spatula down — a few small lumps are fine in muffins."],["Scrape the bowl","Stand mixers leave a butter pocket at the bottom. Scrape down at least once mid-mix or you'll find streaks in the crumb."],["If the batter splits","Eggs went in too fast or too cold. Beat in a tablespoon of the recipe's flour and it usually comes straight back together."],["Add vanilla with the butter","Vanilla is fat-soluble — adding it during creaming disperses the flavour through the whole batter rather than sitting in the liquid."]]},{"group":"Oven know-how","tips":[["Fan-forced runs hot","A fan oven cooks about 20°C 'hotter' than conventional at the same setting because moving air strips heat into food faster. All temps in this app are already fan-forced — add 20°C if you're using conventional."],["Middle shelf is home","Even with a fan circulating, heat still rises and elements bias the extremes: the top shelf browns faster, the bottom crisps bases. Middle gives the most even set — use the top shelf deliberately when you want colour, not by default."],["Don't open the door early","For roughly the first two-thirds of the bake, the structure is still liquid foam. A rush of cold air drops the oven 10–25°C and the centre collapses before it sets. Look through the glass instead."],["Preheat properly","The beep often comes before the oven walls have real heat in them. Give it 15–20 minutes — batter hitting an under-heated oven spreads before it rises."],["Buy a $10 oven thermometer","Home ovens are commonly 10–25°C off their dial. If your bakes always run over or under time, this is almost certainly why."],["Dark pans bake harder","Dark metal absorbs radiant heat and browns edges faster. Knock 10°C off, or check early."],["Two trays? Swap and rotate","Bake one tray at a time in the middle for the evenest biscuits; if you must run two, swap shelves and rotate front-to-back halfway."],["Know your done tests","Skewer clean (or moist crumbs for mud cake and brownies), the centre springs back from a light press, and the cake just pulls from the pan sides. Trust the cake, not the clock."]]},{"group":"Pans & prep","tips":[["Grease AND line","Grease holds the paper in place; paper guarantees release. For long bakes like mud cake, run a paper collar 2–3 cm above the rim to shield the edges from over-browning."],["Fill pans two-thirds, no more","Fuller than that and batter overflows or domes hard; emptier and it dries out. It's also why this app's volume scaling warns you about depth."],["Tap the pan before baking","A couple of firm taps on the bench pops the big trapped air pockets that would otherwise become tunnels."],["Measure across the top","Pan sizes are measured across the inside top edge, not the base — sloped sides can differ by 2 cm, which matters for scaling."]]},{"group":"Cooling, icing & finishing","tips":[["Why 10 minutes in the pan?","Straight out of the oven a cake is fragile and steamy — that brief rest lets the structure firm and steam loosen the sides. Then move it to a rack, or the trapped steam turns the base soggy."],["Mud cake and brownies: cool completely in the pan","Fudgy bakes finish setting as they cool; move them warm and they break. Patience is the last ingredient."],["Ice cold cakes only","Buttercream on a warm cake melts and slides. Level and fill when fully cold — chilled is even better for carving and crumb-coating."],["Crumb coat first","A thin sweep of icing to glue down loose crumbs, 20 minutes in the fridge, then the proper coat goes on clean."],["Cold cream whips best","Cream, bowl and beaters straight from the fridge whip faster and stiffer — warm cream can refuse entirely."],["Ganache ratios","Dark chocolate 1:1 with cream; milk chocolate 2:1 chocolate to cream; white 3:1 — the less cocoa solids, the more chocolate you need for the same set."],["Use block cream cheese","For frosting, the block (not tub spread) — tubs have added water and turn icing to soup. Beat the butter and sugar first, add cold cream cheese last, briefly."]]},{"group":"Biscuits & pastry","tips":[["Chill biscuit dough","Cold butter spreads less in the oven, so biscuits hold shape; resting also hydrates the flour and deepens flavour and browning. Even 30 minutes shows."],["Slightly underbake biscuits","They keep cooking on the hot tray and crisp as they cool — golden edges, soft middle is the moment. Anzacs especially firm up dramatically off the heat."],["Cool the trays between batches","Dough on a hot tray starts melting before it hits the oven and spreads thin. Rotate two trays or run them under cold water."],["Rest rolled pastry","30 minutes in the fridge after rolling relaxes gluten so the pastry doesn't shrink down the tin sides in the oven."],["Blind bake means weights","Paper plus baking weights (or rice/dried beans) holds the base flat while it sets; a few minutes uncovered after dries it out. Docking with a fork stops bubbles."],["Beat the soggy bottom","Bake tarts and pies on a preheated metal tray — the burst of bottom heat sets the base before the filling can soak in. Metal tins beat ceramic for the same reason."],["Egg wash vs milk","Whole beaten egg gives shine and deep golden colour; milk gives a softer, paler finish. Egg yolk only = maximum bronze."]]},{"group":"Meringue & pavlova","tips":[["Separate cold, whip warm","Yolks are firmest straight from the fridge (cleaner separation), but whites whip to their best volume at room temperature. Separate first, then let the whites sit 20 minutes."],["Fat is the enemy of foam","A trace of yolk or grease stops whites foaming. Scrupulously clean bowl — wiping it with a cut lemon or splash of vinegar helps — and never a plastic bowl, which holds grease."],["Sugar goes in slowly","Add it a spoonful at a time from soft peaks. Rub a little meringue between your fingers: gritty means keep whisking until the sugar's dissolved, or it'll weep in the oven."],["Acid and cornflour make the mallow","A teaspoon of vinegar or cream of tartar stabilises the foam; cornflour softens the interior — that's the classic pavlova's crisp shell and marshmallow centre."],["Cool the pav in the oven","Cracks come from sudden temperature change. Switch the oven off and leave the pavlova inside, door ajar, until completely cool."]]},{"group":"Bread & sourdough","tips":[["The windowpane test","Stretch a small piece of dough thin — if it goes translucent without tearing, gluten is developed and kneading is done."],["Never let dough dry out","An uncovered dough forms a skin that strangles the rise. Cover with a damp tea towel or oiled cling film every time it rests."],["Steam makes the crust","Professional crust comes from steam in the first 15–20 minutes — it keeps the surface flexible for maximum rise, then crisps glossy. A lidded Dutch oven or a tray of boiling water on the oven floor does it at home."],["The hollow tap","A baked loaf sounds hollow when tapped on its base. Dull thud = give it longer."],["Don't slice warm bread","The crumb is still setting and steaming — cut early and it gums and staling accelerates. Give a big loaf 1–2 hours."],["Don't refrigerate bread","Fridge temperatures actually speed up staling. Airtight at room temp for days one–two, then freeze sliced."]]},{"group":"Troubleshooting","tips":[["Sunken middle","Usual suspects: door opened too early, underbaked centre, or too much raising agent — an over-leavened cake rises fast then collapses. Measure raising agents level, not heaped."],["Peaked, cracked top","Oven too hot: the outside set while the middle was still pushing up. Drop 10–15°C next time (and check with a thermometer)."],["Dense, heavy crumb","Under-creamed butter, cold ingredients splitting the batter, or overmixing after the flour. All three kill the air the cake needed."],["Dry cake","Overbaked, or too much flour — which is why weighing matters. Check 5 minutes before the recipe says."],["Biscuits spread into puddles","Butter or dough too warm, or the trays were still hot. Chill the dough, cool the trays."],["Soapy or metallic aftertaste","Too much bicarb, or bicarb with nothing acidic to react with. Level teaspoons and check the recipe pairs it with buttermilk, golden syrup, brown sugar or cocoa."]]},{"group":"Storage & make-ahead","tips":[["Most butter cakes freeze beautifully","Un-iced, double-wrapped in cling film then foil: 3 months. Thaw wrapped at room temperature so condensation forms on the wrap, not the cake."],["Keep crisp and soft apart","Store crisp biscuits and soft ones in separate airtight containers — moisture migrates and the crisp ones go sad within a day."],["Slices keep best in the tin","Most set slices hold a week refrigerated in an airtight container; cut with a hot dry knife for clean edges every time."]]}];

function TipsPage({ kitchenTimers, setKitchenTimers, myTips, onAddTip, onRemoveTip }) {
  const [view, setViewMode] = useState("tips"); // tips | tools
  const [open, setOpen] = useState(() => new Set());
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");

  const submitTip = () => {
    if (!newBody.trim()) return;
    onAddTip({ title: newTitle.trim(), body: newBody.trim() });
    setNewTitle(""); setNewBody(""); setAdding(false);
    setOpen((prev) => new Set(prev).add("My tips"));
  };
  const toggle = (g) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(g)) n.delete(g); else n.add(g);
      return n;
    });

  const renderGroup = (g) => {
    const isOpen = open.has(g.group);
    return (
      <section key={g.group} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "4px 20px" }}>
        <button
          onClick={() => toggle(g.group)}
          aria-expanded={isOpen}
          style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: "none", border: "none", padding: "14px 0", textAlign: "left" }}
        >
          <span style={{ ...sectionHead(), margin: 0 }}>{g.group}</span>
          <span aria-hidden="true" style={{ color: C.mustard, fontSize: 18, fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>
            {isOpen ? "−" : "+"}
          </span>
        </button>
        {isOpen && (
          <div style={{ paddingBottom: 14 }}>
            {g.intro && <p style={{ fontSize: 13.5, color: C.inkSoft, margin: "0 0 10px", lineHeight: 1.5 }}>{g.intro}</p>}
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {g.tips.map((t, i) => (
                <li key={i} style={{ padding: "9px 0", borderBottom: i < g.tips.length - 1 ? `1px solid ${C.line}` : "none" }}>
                  {Array.isArray(t) ? (
                    <div style={{ fontSize: 14, lineHeight: 1.55 }}>
                      <span style={{ fontWeight: 700 }}>{t[0]}</span>
                      <span style={{ color: C.inkSoft }}> — {t[1]}</span>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 10, fontSize: 14.5, lineHeight: 1.55 }}>
                      <span style={{ color: C.mustard, fontWeight: 700, flexShrink: 0 }}>•</span>
                      <span>{t}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {[["tips", "Tips"], ["tools", `Tools${kitchenTimers.filter((t) => t.running).length ? ` · ${kitchenTimers.filter((t) => t.running).length} ⏱` : ""}`]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setViewMode(id)}
            style={{
              border: `1px solid ${view === id ? C.green : C.line}`,
              background: view === id ? C.green : C.card,
              color: view === id ? C.onPrimary : C.inkSoft,
              borderRadius: 999, padding: "9px 22px", fontSize: 14, fontWeight: 600,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "tools" && <ToolsPage timers={kitchenTimers} setTimers={setKitchenTimers} />}

      {view === "tips" && (<>
      <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 28, margin: "0 0 6px" }}>Cooking tips</h1>
      <p style={{ color: C.inkSoft, fontSize: 14.5, margin: "0 0 20px", lineHeight: 1.55 }}>
        The habits that quietly make everyday cooking and baking better. Tap a heading to open it.
      </p>

      <div style={{ ...sectionHead(), fontSize: 14, color: C.ink, marginBottom: 10 }}>My tips</div>
      <div style={{ display: "grid", gap: 12, marginBottom: 26 }}>
        <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "4px 20px" }}>
          <button
            onClick={() => toggle("My tips")}
            aria-expanded={open.has("My tips")}
            style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: "none", border: "none", padding: "14px 0", textAlign: "left" }}
          >
            <span style={{ ...sectionHead(), margin: 0 }}>Things I've learnt ({myTips.length})</span>
            <span aria-hidden="true" style={{ color: C.mustard, fontSize: 18, fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>
              {open.has("My tips") ? "−" : "+"}
            </span>
          </button>
          {open.has("My tips") && (
            <div style={{ paddingBottom: 14 }}>
              {!myTips.length && !adding && (
                <p style={{ fontSize: 13.5, color: C.inkSoft, margin: "0 0 10px", lineHeight: 1.5 }}>
                  Nothing here yet — add the things you learn along the way and they'll live alongside the built-in tips.
                </p>
              )}
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {myTips.map((t, i) => (
                  <li key={t.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 0", borderBottom: i < myTips.length - 1 ? `1px solid ${C.line}` : "none" }}>
                    <div style={{ flex: 1, fontSize: 14, lineHeight: 1.55 }}>
                      {t.title ? (
                        <>
                          <span style={{ fontWeight: 700 }}>{t.title}</span>
                          <span style={{ color: C.inkSoft }}> — {t.body}</span>
                        </>
                      ) : (
                        <span>{t.body}</span>
                      )}
                    </div>
                    <button
                      onClick={() => onRemoveTip(t.id)}
                      aria-label="Delete tip"
                      style={{ background: "none", border: "none", color: C.faint, fontSize: 16, padding: "0 2px", flexShrink: 0 }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              {!adding ? (
                <button
                  onClick={() => setAdding(true)}
                  style={{ marginTop: myTips.length ? 12 : 0, background: "none", border: `1px dashed ${C.line}`, borderRadius: 999, padding: "8px 16px", fontSize: 13, color: C.inkSoft, fontWeight: 500 }}
                >
                  + Add a tip
                </button>
              ) : (
                <div style={{ marginTop: 12 }}>
                  <input
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="Title (optional) — e.g. Resting sourdough overnight"
                    style={{ width: "100%", padding: "9px 13px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, marginBottom: 8, fontSize: 14 }}
                  />
                  <textarea
                    value={newBody}
                    onChange={(e) => setNewBody(e.target.value)}
                    rows={3}
                    placeholder="The tip itself…"
                    style={{ width: "100%", padding: "9px 13px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, resize: "vertical", lineHeight: 1.5, fontSize: 14 }}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button onClick={submitTip} style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "8px 18px", fontSize: 13.5, fontWeight: 600 }}>
                      Save tip
                    </button>
                    <button onClick={() => { setAdding(false); setNewTitle(""); setNewBody(""); }} style={{ background: "none", border: "none", color: C.inkSoft, fontSize: 13 }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <div style={{ ...sectionHead(), fontSize: 14, color: C.ink, marginBottom: 10 }}>Everyday cooking</div>
      <div style={{ display: "grid", gap: 12, marginBottom: 26 }}>
        {TIPS.map(renderGroup)}
      </div>

      <div style={{ ...sectionHead(), fontSize: 14, color: C.ink, marginBottom: 10 }}>Baking</div>
      <div style={{ display: "grid", gap: 12 }}>
        {TIPS_BAKING.map(renderGroup)}
      </div>
      </>)}
    </div>
  );
}

/* ---------- settings ---------- */

function SettingsPage({ settings, update, myPans, onAddPan, onRemovePan, onExport, onImport, restoreStarters, resetAll }) {
  const [panForm, setPanForm] = useState(null); // null | {name, shape, dims…}
  const [confirmPanDel, setConfirmPanDel] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const serveOptions = [null, 1, 2, 3, 4, 5, 6, 8, 10];

  return (
    <div style={{ maxWidth: 620 }}>
      <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 28, margin: "0 0 20px" }}>Settings</h1>

      <section style={settingsCard()}>
        <h2 style={sectionHead()}>Appearance</h2>
        <p style={settingsHint()}>Pick a colour theme, and whether the app follows your device's light or dark setting.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {THEME_LIST.map(([id, label, swA, swB]) => {
            const active = settings.theme === id;
            return (
              <button
                key={id}
                onClick={() => update({ theme: id })}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  border: `1px solid ${active ? C.green : C.line}`,
                  background: active ? C.green : C.bg,
                  color: active ? C.onPrimary : C.inkSoft,
                  borderRadius: 999, padding: "8px 16px", fontSize: 13.5, fontWeight: 600,
                }}
              >
                <span aria-hidden="true" style={{ display: "inline-flex" }}>
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: swA, border: "1px solid rgba(255,255,255,0.5)" }} />
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: swB, marginLeft: -4, border: "1px solid rgba(255,255,255,0.5)" }} />
                </span>
                {label}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[["auto", "Match device"], ["light", "Light"], ["dark", "Dark"]].map(([id, label]) => {
            const active = settings.mode === id;
            return (
              <button
                key={id}
                onClick={() => update({ mode: id })}
                style={{
                  border: `1px solid ${active ? C.green : C.line}`,
                  background: active ? C.green : C.bg,
                  color: active ? C.onPrimary : C.inkSoft,
                  borderRadius: 999, padding: "8px 16px", fontSize: 13.5, fontWeight: 600,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </section>

      <section style={settingsCard()}>
        <h2 style={sectionHead()}>Household serves</h2>
        <p style={settingsHint()}>
          Every recipe opens already scaled to this number, and meals added to the planner default to it. Choose “As written” to open recipes at their original serves.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {serveOptions.map((n) => {
            const active = settings.defaultServes === n;
            return (
              <button
                key={String(n)}
                onClick={() => update({ defaultServes: n })}
                style={{
                  border: `1px solid ${active ? C.green : C.line}`,
                  background: active ? C.green : C.bg,
                  color: active ? C.onPrimary : C.inkSoft,
                  borderRadius: 999, padding: "8px 16px", fontSize: 13.5, fontWeight: 600,
                }}
              >
                {n == null ? "As written" : n}
              </button>
            );
          })}
        </div>
      </section>

      <section style={settingsCard()}>
        <h2 style={sectionHead()}>Prep check-off</h2>
        <p style={settingsHint()}>
          Show a tick box beside each ingredient on recipe pages, so you can check things off as you measure and prep them. Ticks are per cooking session — they clear when you leave the recipe or change the scaling.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {[[true, "On"], [false, "Off"]].map(([val, label]) => {
            const active = (settings.prepTicks !== false) === val;
            return (
              <button
                key={label}
                onClick={() => update({ prepTicks: val })}
                style={{
                  border: `1px solid ${active ? C.green : C.line}`,
                  background: active ? C.green : C.bg,
                  color: active ? C.onPrimary : C.inkSoft,
                  borderRadius: 999, padding: "8px 20px", fontSize: 13.5, fontWeight: 600,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </section>

      <section style={settingsCard()}>
        <h2 style={sectionHead()}>Oven type</h2>
        <p style={settingsHint()}>
          Recipes are written for fan-forced. Switch to conventional and every oven temperature in the methods displays 20°C higher automatically.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {[["fan", "Fan-forced"], ["conventional", "Conventional"]].map(([id, label]) => {
            const active = settings.oven === id;
            return (
              <button
                key={id}
                onClick={() => update({ oven: id })}
                style={{
                  border: `1px solid ${active ? C.green : C.line}`,
                  background: active ? C.green : C.bg,
                  color: active ? C.onPrimary : C.inkSoft,
                  borderRadius: 999, padding: "8px 18px", fontSize: 13.5, fontWeight: 600,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </section>

      <section style={settingsCard()}>
        <h2 style={sectionHead()}>My pans</h2>
        <p style={settingsHint()}>
          Save the tins you actually own and they'll appear as one-tap options on every pan-scaled baking recipe.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {myPans.map((p) =>
            confirmPanDel === p.id ? (
              <button
                key={p.id}
                onClick={() => { onRemovePan(p.id); setConfirmPanDel(null); }}
                style={{ background: C.danger, border: "none", color: "#fff", borderRadius: 999, padding: "7px 16px", fontSize: 13, fontWeight: 600 }}
              >
                Delete “{p.name || panLabel(p)}”?
              </button>
            ) : (
              <span key={p.id} title={panLabel(p)} style={{ display: "inline-flex", alignItems: "center", border: `1px solid ${C.line}`, borderRadius: 999, background: C.bg, overflow: "hidden" }}>
                <span style={{ padding: "7px 6px 7px 14px", fontSize: 13, fontWeight: 600 }}>{p.name || panLabel(p)}</span>
                <button
                  onClick={() => setConfirmPanDel(p.id)}
                  aria-label={`Delete pan ${p.name || panLabel(p)}`}
                  style={{ background: "none", border: "none", padding: "7px 12px 7px 6px", fontSize: 15, color: C.danger }}
                >
                  ×
                </button>
              </span>
            )
          )}
          {!panForm && (
            <button
              onClick={() => setPanForm({ name: "", shape: "round", diameter: 20, quantity: 1 })}
              style={{ background: "none", border: `1px dashed ${C.line}`, borderRadius: 999, padding: "7px 14px", fontSize: 13, color: C.inkSoft, fontWeight: 500 }}
            >
              + Add a pan
            </button>
          )}
        </div>
        {panForm && (
          <div style={{ marginTop: 12 }}>
            <input
              value={panForm.name}
              onChange={(e) => setPanForm({ ...panForm, name: e.target.value })}
              placeholder='Name (optional) — e.g. "The good bundt tin"'
              style={{ width: "100%", padding: "9px 13px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, marginBottom: 10, fontSize: 14 }}
            />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ fontSize: 12, color: C.inkSoft }}>
                Shape<br />
                <select
                  value={panForm.shape}
                  onChange={(e) => {
                    const shape = e.target.value;
                    if (shape === "round") setPanForm({ name: panForm.name, shape, diameter: 20, quantity: panForm.quantity || 1 });
                    else if (shape === "square") setPanForm({ name: panForm.name, shape, side: 20, quantity: panForm.quantity || 1 });
                    else if (shape === "bundt") setPanForm({ name: panForm.name, shape, cups: 10, quantity: panForm.quantity || 1 });
                    else if (shape === "dutch") setPanForm({ name: panForm.name, shape, litres: 5, quantity: panForm.quantity || 1 });
                    else if (shape === "loaf") setPanForm({ name: panForm.name, shape, length: 26, width: 13, quantity: panForm.quantity || 1 });
                    else setPanForm({ name: panForm.name, shape: "rectangle", length: 30, width: 20, quantity: panForm.quantity || 1 });
                  }}
                  style={{ marginTop: 4, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, fontSize: 14 }}
                >
                  <option value="round">Round</option>
                  <option value="square">Square</option>
                  <option value="rectangle">Rectangle</option>
                  <option value="loaf">Cast-iron loaf</option>
                  <option value="bundt">Bundt (cups)</option>
                  <option value="dutch">Dutch oven (litres)</option>
                </select>
              </label>
              {panForm.shape === "dutch" && (
                <label style={{ fontSize: 12, color: C.inkSoft }}>Capacity (litres)<br /><input type="number" min="1" step="0.5" value={panForm.litres || ""} onChange={(e) => setPanForm({ ...panForm, litres: Number(e.target.value) })} style={{ marginTop: 4, width: 100, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, fontSize: 14 }} /></label>
              )}
              {panForm.shape === "bundt" && (
                <label style={{ fontSize: 12, color: C.inkSoft }}>Capacity (cups)<br /><input type="number" min="1" step="0.5" value={panForm.cups || ""} onChange={(e) => setPanForm({ ...panForm, cups: Number(e.target.value) })} style={{ marginTop: 4, width: 100, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, fontSize: 14 }} /></label>
              )}
              {panForm.shape === "round" && (
                <label style={{ fontSize: 12, color: C.inkSoft }}>Diameter (cm)<br /><input type="number" min="1" value={panForm.diameter || ""} onChange={(e) => setPanForm({ ...panForm, diameter: Number(e.target.value) })} style={{ marginTop: 4, width: 90, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, fontSize: 14 }} /></label>
              )}
              {panForm.shape === "square" && (
                <label style={{ fontSize: 12, color: C.inkSoft }}>Side (cm)<br /><input type="number" min="1" value={panForm.side || ""} onChange={(e) => setPanForm({ ...panForm, side: Number(e.target.value) })} style={{ marginTop: 4, width: 90, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, fontSize: 14 }} /></label>
              )}
              {(panForm.shape === "rectangle" || panForm.shape === "loaf") && (
                <>
                  <label style={{ fontSize: 12, color: C.inkSoft }}>Length (cm)<br /><input type="number" min="1" value={panForm.length || ""} onChange={(e) => setPanForm({ ...panForm, length: Number(e.target.value) })} style={{ marginTop: 4, width: 90, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, fontSize: 14 }} /></label>
                  <label style={{ fontSize: 12, color: C.inkSoft }}>Width (cm)<br /><input type="number" min="1" value={panForm.width || ""} onChange={(e) => setPanForm({ ...panForm, width: Number(e.target.value) })} style={{ marginTop: 4, width: 90, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, fontSize: 14 }} /></label>
                </>
              )}
              <label style={{ fontSize: 12, color: C.inkSoft }}>How many<br /><input type="number" min="1" max="6" value={panForm.quantity || 1} onChange={(e) => setPanForm({ ...panForm, quantity: Number(e.target.value) })} style={{ marginTop: 4, width: 80, padding: "8px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.card, fontSize: 14 }} /></label>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                onClick={() => {
                  const { name, ...geom } = panForm;
                  const ok = (geom.shape === "round" && geom.diameter > 0) || (geom.shape === "square" && geom.side > 0) || (geom.shape === "bundt" && geom.cups > 0) || (geom.shape === "dutch" && geom.litres > 0) || ((geom.shape === "rectangle" || geom.shape === "loaf") && geom.length > 0 && geom.width > 0);
                  if (!ok) return;
                  onAddPan({ name: name.trim(), ...geom });
                  setPanForm(null);
                }}
                style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "8px 18px", fontSize: 13.5, fontWeight: 600 }}
              >
                Save pan
              </button>
              <button onClick={() => setPanForm(null)} style={{ background: "none", border: "none", color: C.inkSoft, fontSize: 13 }}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      <section style={settingsCard()}>
        <h2 style={sectionHead()}>Backup & transfer</h2>
        <p style={settingsHint()}>
          Data lives on this device only. Export a backup file here, then import it on another device (or after reinstalling) to move your whole kitchen across — recipes, photos, planner, templates, shopping list and settings.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={onExport}
            style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "9px 18px", fontSize: 13.5, fontWeight: 600 }}
          >
            Export backup
          </button>
          <label style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: "9px 18px", fontSize: 13.5, fontWeight: 500, cursor: "pointer" }}>
            Import backup…
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => { onImport(e.target.files && e.target.files[0]); e.target.value = ""; }}
            />
          </label>
        </div>
        <p style={{ ...settingsHint(), margin: "10px 0 0", fontSize: 12.5 }}>
          Importing replaces everything currently on this device with the backup's contents.
        </p>
      </section>

      <section style={settingsCard()}>
        <h2 style={sectionHead()}>Your data</h2>
        <p style={settingsHint()}>
          Recipes, the planner, the shopping list and these settings are saved on this device automatically.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={restoreStarters}
            style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: "9px 18px", fontSize: 13.5, fontWeight: 500 }}
          >
            Restore starter recipes
          </button>
          {!confirmReset ? (
            <button
              onClick={() => setConfirmReset(true)}
              style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: "9px 18px", fontSize: 13.5, color: C.danger, fontWeight: 500 }}
            >
              Reset everything…
            </button>
          ) : (
            <button
              onClick={() => { resetAll(); setConfirmReset(false); }}
              style={{ background: C.danger, border: "none", color: "#fff", borderRadius: 999, padding: "9px 18px", fontSize: 13.5, fontWeight: 600 }}
            >
              Confirm — wipe recipes, planner and list
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

const settingsCard = () => ({
  background: C.card, border: `1px solid ${C.line}`, borderRadius: 16,
  padding: "18px 20px", marginBottom: 14,
});

const settingsHint = () => ({
  fontSize: 13.5, color: C.inkSoft, margin: "0 0 12px", lineHeight: 1.55,
});


/* ---------- shared helpers: time, aisles, timers, images, paste import ---------- */

function timeAgo(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  if (d < 31) return `${Math.round(d / 7)} wk ago`;
  if (d < 365) return `${Math.round(d / 30)} mo ago`;
  return `${Math.round(d / 365)} yr ago`;
}

const AISLES = [
  ["Frozen", ["frozen"]],
  ["Bakery", ["bread", "tortilla", "wrap", "roll", "bun", "pita", "sourdough"]],
  ["Pantry", ["pasta", "spaghetti", "noodle", "rice", "flour", "sugar", "oil", "stock", "passata", "tin", "canned", "paste", "sauce", "soy", "oyster", "sesame", "vinegar", "spice", "paprika", "cumin", "oregano", "nutmeg", "cinnamon", "curry", "coconut", "honey", "salt", "pepper", "lentil", "chickpea", "dried", "chocolate", "cocoa", "vanilla", "baking", "yeast", "cereal", "oats", "peanut butter"]],
  ["Dairy & Eggs", ["milk", "cream", "cheese", "butter", "yoghurt", "yogurt", "egg", "parmesan", "feta", "mozzarella", "halloumi"]],
  ["Meat & Seafood", ["mince", "chicken", "beef", "pork", "lamb", "bacon", "ham", "sausage", "chorizo", "fish", "salmon", "tuna", "prawn", "steak", "turkey", "duck", "seafood", "fillet"]],
  ["Drinks", ["wine", "beer", "juice", "soft drink", "kombucha", "cordial"]],
  ["Fruit & Veg", ["onion", "garlic", "carrot", "celery", "tomato", "pumpkin", "bean", "eggplant", "lettuce", "cucumber", "capsicum", "zucchini", "broccoli", "cauliflower", "spinach", "mushroom", "potato", "corn", "pea", "herb", "basil", "coriander", "parsley", "mint", "thyme", "rosemary", "ginger", "chilli", "lemon", "lime", "apple", "banana", "berry", "orange", "avocado", "salad", "kale", "leek", "cabbage", "fruit", "veg"]],
];

function aisleFor(name) {
  const n = name.toLowerCase();
  for (const [label, kws] of AISLES) {
    if (kws.some((k) => n.includes(k))) return label;
  }
  return "Everything else";
}
AISLES.push(["Everything else", []]);

function parseTimerSeconds(text) {
  const m = text.match(/(\d+)\s*(?:[\u2013-]\s*\d+\s*)?(hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|sec)\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  if (u.startsWith("h")) return n * 3600;
  if (u.startsWith("s")) return n;
  return n * 60;
}

function fmtClock(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.3, 0.6].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.25, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + t + 0.25);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.27);
    });
  } catch (e) { /* audio unavailable */ }
}

function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function parsePastedRecipe(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const lower = lines.map((l) => l.toLowerCase());
  const clean = (l) => l.replace(/^[-*\u2022·]\s*/, "").replace(/^(step\s*)?\d+[.):]\s*/i, "");
  const ingIdx = lower.findIndex((l) => /^ingredients\b/.test(l));
  const methodIdx = lower.findIndex((l) => /^(method|instructions|directions|steps)\b/.test(l));
  let title = "", ingLines = [], stepLines = [];

  if (ingIdx !== -1) {
    title = lines.slice(0, ingIdx).find((l) => l && !/^serves/i.test(l) && !/^(prep|cook|total)/i.test(l)) || "";
    const endIng = methodIdx > ingIdx ? methodIdx : lines.length;
    ingLines = lines.slice(ingIdx + 1, endIng).filter(Boolean).map(clean);
    if (methodIdx !== -1) stepLines = lines.slice(methodIdx + 1).filter(Boolean).map(clean);
  } else {
    const nonEmpty = lines.filter(Boolean);
    title = nonEmpty[0] || "";
    for (const l of nonEmpty.slice(1)) {
      if (/^serves/i.test(l)) continue;
      const p = parseIngredientLine(l);
      if (p && p.amount != null && l.length < 60) ingLines.push(clean(l));
      else if (l.length > 40 || /[.!]$/.test(l)) stepLines.push(clean(l));
      else ingLines.push(clean(l));
    }
  }
  const servesM = text.match(/serves\s*:?\s*(\d+)/i);
  return { title, ingLines, stepLines, serves: servesM ? parseInt(servesM[1], 10) : null };
}

/* ---------- cook mode ---------- */

function CookMode({ recipe, factor, contextLabel, settings, ticked, onToggleTick, onClose, onCooked }) {
  const [idx, setIdx] = useState(0);
  const [showIng, setShowIng] = useState(false);
  const [timer, setTimer] = useState(null); // { total, left, running, done }
  const steps = recipe.steps;
  const stepText = applyOven(steps[idx], settings.oven);
  const stepSeconds = parseTimerSeconds(stepText);

  // keep the screen awake while cooking
  useEffect(() => {
    let lock = null;
    let active = true;
    const request = () => {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request("screen").then((l) => { if (active) lock = l; else l.release(); }).catch(() => {});
      }
    };
    request();
    const onVis = () => { if (document.visibilityState === "visible") request(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVis);
      if (lock) lock.release().catch(() => {});
    };
  }, []);

  // reset timer when the step changes
  useEffect(() => { setTimer(null); }, [idx]);

  // countdown
  useEffect(() => {
    if (!timer || !timer.running) return;
    const t = setInterval(() => {
      setTimer((prev) => {
        if (!prev || !prev.running) return prev;
        if (prev.left <= 1) { beep(); return { ...prev, left: 0, running: false, done: true }; }
        return { ...prev, left: prev.left - 1 };
      });
    }, 1000);
    return () => clearInterval(t);
  }, [timer && timer.running]);

  const last = idx === steps.length - 1;

  return (
    <div style={{ position: "fixed", inset: 0, background: C.bg, color: C.ink, zIndex: 60, display: "flex", flexDirection: "column", fontFamily: "'Instrument Sans', system-ui, sans-serif" }}>
      <div style={{ background: C.green, color: C.onPrimary, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 700, fontSize: 17, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{recipe.title}</div>
          <div style={{ fontSize: 12.5, opacity: 0.75 }}>{contextLabel} · Step {idx + 1} of {steps.length}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button onClick={() => setShowIng(!showIng)} style={{ background: "none", border: `1px solid ${C.onPrimaryFaint}`, color: C.onPrimary, borderRadius: 999, padding: "7px 14px", fontSize: 13 }}>
            Ingredients
          </button>
          <button onClick={onClose} aria-label="Exit cook mode" style={{ background: "none", border: `1px solid ${C.onPrimaryFaint}`, color: C.onPrimary, borderRadius: 999, padding: "7px 14px", fontSize: 13 }}>
            ✕ Exit
          </button>
        </div>
      </div>

      <div style={{ height: 4, background: C.line }}>
        <div style={{ height: "100%", width: `${((idx + 1) / steps.length) * 100}%`, background: C.mustard, transition: "width 0.25s" }} />
      </div>

      {showIng && (
        <div style={{ background: C.card, borderBottom: `1px solid ${C.line}`, padding: "12px 20px", maxHeight: "38vh", overflowY: "auto" }}>
          {recipe.ingredients.map((it, i) => {
            const amt = it.amount != null ? formatAmount(it.amount * factor, it.unit) : null;
            const done = ticked && ticked.has(i);
            return (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "5px 0", fontSize: 14.5, opacity: done ? 0.5 : 1 }}>
                {ticked && (
                  <button
                    onClick={() => onToggleTick(i)}
                    aria-label={done ? "Mark not measured" : "Mark measured"}
                    style={{ width: 19, height: 19, borderRadius: 6, flexShrink: 0, marginTop: 2, border: `2px solid ${done ? C.green : C.line}`, background: done ? C.green : "transparent", color: C.onPrimary, fontSize: 11, lineHeight: 1, display: "grid", placeItems: "center", padding: 0 }}
                  >
                    {done ? "✓" : ""}
                  </button>
                )}
                <span>{amt != null ? <><strong>{amt}{it.unit ? ` ${it.unit}` : ""}</strong> {it.name}</> : <span style={{ color: C.inkSoft }}>{it.name}</span>}</span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", justifyContent: "center", padding: "28px 24px", maxWidth: 720, margin: "0 auto", width: "100%" }}>
        <div style={{ width: 44, height: 44, borderRadius: "50%", background: C.mustardSoft, color: C.accentText, display: "grid", placeItems: "center", fontWeight: 800, fontSize: 19, marginBottom: 18, fontFamily: "'Bricolage Grotesque'" }}>
          {idx + 1}
        </div>
        <div style={{ fontSize: 24, lineHeight: 1.45, fontWeight: 500 }}>{stepText}</div>

        {stepSeconds && !timer && (
          <button
            onClick={() => setTimer({ total: stepSeconds, left: stepSeconds, running: true, done: false })}
            style={{ marginTop: 24, alignSelf: "flex-start", background: C.mustard, color: C.onAccent, border: "none", borderRadius: 999, padding: "12px 22px", fontSize: 15, fontWeight: 700 }}
          >
            ⏱ Start {Math.round(stepSeconds / 60) >= 60 ? `${Math.round(stepSeconds / 3600 * 10) / 10} hr` : `${Math.round(stepSeconds / 60)} min`} timer
          </button>
        )}

        {timer && (
          <div style={{ marginTop: 24, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{
              background: timer.done ? C.mustard : C.card,
              border: `1px solid ${timer.done ? C.mustard : C.line}`,
              color: timer.done ? C.onAccent : C.ink,
              borderRadius: 16, padding: "12px 22px",
              fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 34, fontVariantNumeric: "tabular-nums",
              animation: timer.done ? "timerDone 1s ease 3" : "none",
            }}>
              {timer.done ? "Time's up!" : fmtClock(timer.left)}
            </div>
            {!timer.done && (
              <button
                onClick={() => setTimer({ ...timer, running: !timer.running })}
                style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 999, padding: "10px 18px", fontSize: 14, fontWeight: 600 }}
              >
                {timer.running ? "Pause" : "Resume"}
              </button>
            )}
            <button
              onClick={() => setTimer(null)}
              style={{ background: "none", border: "none", color: C.inkSoft, fontSize: 13.5 }}
            >
              Reset
            </button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, padding: "16px 20px calc(16px + env(safe-area-inset-bottom))", borderTop: `1px solid ${C.line}`, background: C.card }}>
        <button
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          disabled={idx === 0}
          style={{ flex: 1, background: C.bg, border: `1px solid ${C.line}`, color: idx === 0 ? C.disabledText : C.ink, borderRadius: 14, padding: "15px 10px", fontSize: 15, fontWeight: 600 }}
        >
          ← Back
        </button>
        {!last ? (
          <button
            onClick={() => setIdx((i) => Math.min(steps.length - 1, i + 1))}
            style={{ flex: 2, background: C.green, color: C.onPrimary, border: "none", borderRadius: 14, padding: "15px 10px", fontSize: 15, fontWeight: 700 }}
          >
            Next step →
          </button>
        ) : (
          <button
            onClick={onCooked}
            style={{ flex: 2, background: C.mustard, color: C.onAccent, border: "none", borderRadius: 14, padding: "15px 10px", fontSize: 15, fontWeight: 700 }}
          >
            ✓ Finish & mark cooked
          </button>
        )}
      </div>
    </div>
  );
}


/* ---------- kitchen tools ---------- */

const SUBSTITUTIONS = [
  ["Buttermilk (250 ml)", "250 ml milk + 1 tbsp lemon juice or white vinegar — rest 10 minutes until it thickens"],
  ["Self-raising flour (150 g)", "150 g plain flour + 2 tsp baking powder"],
  ["Baking powder (1 tsp)", "¼ tsp bicarb soda + ½ tsp cream of tartar"],
  ["Caster sugar", "blitz white sugar in a food processor for 20 seconds"],
  ["Brown sugar (100 g)", "100 g white sugar + 1 tbsp golden syrup or molasses, rubbed through"],
  ["Sour cream", "Greek-style natural yoghurt, 1:1"],
  ["Fresh herbs (1 tbsp)", "1 tsp dried — add earlier in the cook"],
  ["Garlic clove (1)", "¼ tsp garlic powder"],
  ["Fish sauce (1 tbsp)", "1 tbsp soy sauce + a squeeze of lime"],
  ["Wine in cooking", "same amount of stock + 1 tsp vinegar"],
  ["Cornflour for thickening (1 tbsp)", "2 tbsp plain flour (simmer a little longer)"],
  ["Fresh yeast (15 g)", "7 g dried yeast, or 5 g instant"],
  ["Egg in baking (1)", "60 g mashed banana or 3 tbsp aquafaba (works best for 1–2 eggs)"],
  ["Golden syrup", "honey, 1:1 (slightly less rich)"],
  ["Tomato passata", "tinned crushed tomatoes, blended smooth"],
];

const ROASTS = {
  "Beef": { temp: 180, extra: 0, rest: 20, options: { "Rare": [20, 55], "Medium": [25, 65], "Well done": [30, 75] } },
  "Lamb": { temp: 180, extra: 0, rest: 20, options: { "Rare": [20, 58], "Medium": [25, 65], "Well done": [30, 72] } },
  "Pork": { temp: 180, extra: 0, rest: 15, options: { "Roast": [30, 70] } },
  "Chicken (whole)": { temp: 190, extra: 20, rest: 10, options: { "Roast": [25, 75] } },
  "Turkey": { temp: 170, extra: 30, rest: 30, options: { "Roast": [20, 74] } },
};

const DONENESS = [
  ["Beef & lamb — rare", "50–55°C"], ["Beef & lamb — medium rare", "55–60°C"], ["Beef & lamb — medium", "60–65°C"],
  ["Beef & lamb — well done", "70°C+"], ["Pork", "70°C"], ["Chicken & turkey", "75°C"],
  ["Duck breast", "60°C"], ["Fish", "60°C (opaque and flaking)"], ["Mince, sausages, rissoles", "71°C — always cooked through"],
];

const GELATINE_NOTES = [
  ["Titanium leaf (≈5 g)", "≈ 1½ tsp powdered gelatine"],
  ["Gold leaf (≈2 g)", "≈ ½ tsp powdered gelatine"],
  ["1 tsp powdered gelatine", "≈ 3.5 g"],
  ["To softly set 500 ml liquid", "≈ 3 tsp powder, 2 titanium leaves or 5 gold leaves"],
  ["Blooming", "leaves: soak in cold water 5 min then squeeze · powder: sprinkle over cold water, stand 5 min, then dissolve in the warm base"],
  ["Never boil", "gelatine loses setting power above ~80°C, and kiwifruit, pineapple and papaya stop it setting entirely unless cooked first"],
];

const LEFTOVER_SAFETY = [
  ["Cooked meat, poultry & stews", "3 days fridge · 2–3 months freezer"],
  ["Cooked rice", "1 day fridge — cool it fast, reheat piping hot"],
  ["Soups & sauces", "3 days fridge · 3 months freezer"],
  ["Cooked fish & seafood", "2 days fridge"],
  ["Raw mince & sausages", "2 days fridge · 3 months freezer"],
  ["Hard-boiled eggs (in shell)", "1 week fridge"],
  ["The 2-hour / 4-hour rule", "under 2 hrs in the danger zone (5–60°C): refrigerate · 2–4 hrs: use immediately · over 4 hrs: bin it"],
];

const IMPERIAL = [
  ["1 oz", 28.35, "g"], ["1 lb", 453.6, "g"], ["1 stick of butter (US)", 113, "g"],
  ["1 US cup", 237, "ml — note AU cups are 250 ml"], ["1 US fl oz", 29.6, "ml"],
  ["1 US tablespoon", 15, "ml — AU tablespoons are 20 ml"],
];

const SEASONS = {
  January: { fruit: "mangoes, peaches, nectarines, berries, lychees", veg: "tomatoes, sweet corn, zucchini, capsicum, beans" },
  February: { fruit: "figs, grapes, plums, melons, passionfruit", veg: "tomatoes, eggplant, sweet corn, capsicum, cucumbers" },
  March: { fruit: "apples, pears, figs, grapes, plums", veg: "pumpkin, eggplant, mushrooms, beans, sweet corn" },
  April: { fruit: "apples, pears, quince, kiwifruit, early mandarins", veg: "pumpkin, mushrooms, broccoli, cauliflower, sweet potato" },
  May: { fruit: "mandarins, oranges, apples, pears, quince", veg: "brussels sprouts, cauliflower, broccoli, silverbeet, leeks" },
  June: { fruit: "oranges, mandarins, lemons, grapefruit, kiwifruit", veg: "cauliflower, brussels sprouts, cabbage, leeks, parsnips" },
  July: { fruit: "oranges, lemons, mandarins, grapefruit, rhubarb", veg: "cauliflower, kale, brussels sprouts, swedes, potatoes" },
  August: { fruit: "oranges, blood oranges, lemons, kiwifruit, rhubarb", veg: "broccoli, cauliflower, spinach, leeks, beetroot" },
  September: { fruit: "early strawberries, blood oranges, pineapple", veg: "asparagus, peas, spinach, artichokes, spring onions" },
  October: { fruit: "strawberries, pineapple, papaya, blueberries", veg: "asparagus, peas, broad beans, lettuce, early zucchini" },
  November: { fruit: "early cherries, berries, mangoes, melons", veg: "beans, zucchini, cucumbers, early tomatoes, asparagus" },
  December: { fruit: "cherries, mangoes, berries, stone fruit, lychees", veg: "tomatoes, sweet corn, beans, zucchini, capsicum" },
};

function ToolCard({ title, open, toggle, children }) {
  return (
    <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "4px 20px" }}>
      <button
        onClick={toggle}
        aria-expanded={open}
        style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: "none", border: "none", padding: "14px 0", textAlign: "left" }}
      >
        <span style={{ ...sectionHead(), margin: 0 }}>{title}</span>
        <span aria-hidden="true" style={{ color: C.mustard, fontSize: 18, fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>{open ? "−" : "+"}</span>
      </button>
      {open && <div style={{ paddingBottom: 16 }}>{children}</div>}
    </section>
  );
}

const toolInput = () => ({ width: "100%", padding: "9px 12px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, fontSize: 14 });
const toolLabel = { fontSize: 12, color: "inherit", display: "block" };
const resultBox = () => ({ background: C.mustardSoft, borderRadius: 10, padding: "12px 14px", color: C.noteText, fontSize: 14, lineHeight: 1.55, marginTop: 10 });

function ChartRows({ rows }) {
  return (
    <div>
      {rows.map(([a, b], i) => (
        <div key={i} style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: i < rows.length - 1 ? `1px solid ${C.line}` : "none", fontSize: 13.5, lineHeight: 1.5 }}>
          <span style={{ fontWeight: 700, flex: "0 0 46%" }}>{a}</span>
          <span style={{ color: C.inkSoft }}>{b}</span>
        </div>
      ))}
    </div>
  );
}

function ToolsPage({ timers, setTimers }) {
  const [open, setOpen] = useState(() => new Set(timers.length ? ["Kitchen timers"] : []));
  const toggle = (t) => setOpen((prev) => { const n = new Set(prev); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const T = (title, children) => <ToolCard key={title} title={title} open={open.has(title)} toggle={() => toggle(title)}>{children}</ToolCard>;

  // cups & spoons
  const [cupItem, setCupItem] = useState("Plain / SR flour");
  const [cupMl, setCupMl] = useState(250);
  // imperial
  const [impIdx, setImpIdx] = useState(0);
  const [impQty, setImpQty] = useState(1);
  // scaling
  const [scAmt, setScAmt] = useState(340);
  const [scFrom, setScFrom] = useState(4);
  const [scTo, setScTo] = useState(6);
  // roast
  const [meat, setMeat] = useState("Beef");
  const [doneness, setDoneness] = useState("Medium");
  const [weight, setWeight] = useState(1.5);
  // sourdough
  const [sdFlour, setSdFlour] = useState(500);
  const [sdWater, setSdWater] = useState(350);
  const [sdStarter, setSdStarter] = useState(100);
  const [sdHyd, setSdHyd] = useState(100);
  // eggs
  const [eggCount, setEggCount] = useState(3);
  const [eggSize, setEggSize] = useState(50);
  // timers
  const [tName, setTName] = useState("");
  const [tMins, setTMins] = useState(10);
  // seasons
  const monthNames = Object.keys(SEASONS);
  const [month, setMonth] = useState(monthNames[new Date().getMonth()]);

  const roast = ROASTS[meat];
  const roastOpt = roast.options[doneness] || Object.values(roast.options)[0];
  const roastMins = Math.round((Math.max(0.2, Number(weight) || 0) * 1000 / 500) * roastOpt[0] + roast.extra);

  const starterFlour = (Number(sdStarter) || 0) * 100 / (100 + (Number(sdHyd) || 100));
  const starterWater = (Number(sdStarter) || 0) - starterFlour;
  const totFlour = (Number(sdFlour) || 0) + starterFlour;
  const totWater = (Number(sdWater) || 0) + starterWater;
  const hydration = totFlour ? Math.round((totWater / totFlour) * 1000) / 10 : 0;

  const eggTotal = (Number(eggCount) || 0) * 60;
  const eggNeeded = Math.round((eggTotal / (Number(eggSize) || 60)) * 4) / 4;

  return (
    <div>
      <h1 style={{ fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 28, margin: "0 0 6px" }}>Kitchen tools</h1>
      <p style={{ color: C.inkSoft, fontSize: 14.5, margin: "0 0 18px", lineHeight: 1.55 }}>
        Calculators and reference charts for the questions that come up mid-cook. Timers keep running wherever you are in the app.
      </p>
      <div style={{ display: "grid", gap: 12 }}>

        {T("Kitchen timers", (<>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: timers.length ? 12 : 0 }}>
            <label style={{ ...toolLabel, color: C.inkSoft, flex: "1 1 140px" }}>Name<br />
              <input value={tName} onChange={(e) => setTName(e.target.value)} placeholder="e.g. Pasta" style={{ ...toolInput(), marginTop: 4 }} />
            </label>
            <label style={{ ...toolLabel, color: C.inkSoft, width: 90 }}>Minutes<br />
              <input type="number" min="1" max="600" value={tMins} onChange={(e) => setTMins(e.target.value)} style={{ ...toolInput(), marginTop: 4 }} />
            </label>
            <button
              onClick={() => {
                const m = Math.max(1, parseInt(tMins, 10) || 0);
                setTimers([...timers, { id: uid(), name: tName.trim() || `${m} min timer`, total: m * 60, left: m * 60, running: true, done: false }]);
                setTName("");
              }}
              style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "10px 20px", fontSize: 13.5, fontWeight: 600 }}
            >
              Start
            </button>
          </div>
          {timers.map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: `1px solid ${C.line}`, flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 120px", fontWeight: 600, fontSize: 14.5 }}>{t.name}</span>
              <span style={{
                fontFamily: "'Bricolage Grotesque'", fontWeight: 800, fontSize: 22, fontVariantNumeric: "tabular-nums",
                color: t.done ? C.mustard : C.ink, animation: t.done ? "timerDone 1s ease 3" : "none",
                background: t.done ? C.mustardSoft : "transparent", borderRadius: 8, padding: t.done ? "2px 10px" : 0,
              }}>
                {t.done ? "Done!" : fmtClock(t.left)}
              </span>
              {!t.done && (
                <button onClick={() => setTimers(timers.map((x) => x.id === t.id ? { ...x, running: !x.running } : x))} style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: "6px 14px", fontSize: 12.5, fontWeight: 600 }}>
                  {t.running ? "Pause" : "Resume"}
                </button>
              )}
              <button onClick={() => setTimers(timers.filter((x) => x.id !== t.id))} aria-label="Remove timer" style={{ background: "none", border: "none", color: C.danger, fontSize: 16, padding: "2px 6px" }}>×</button>
            </div>
          ))}
        </>))}

        {T("Cups & spoons → grams (AU standard)", (<>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            <label style={{ ...toolLabel, color: C.inkSoft }}>Ingredient<br />
              <select value={cupItem} onChange={(e) => setCupItem(e.target.value)} style={{ ...toolInput(), marginTop: 4 }}>
                {Object.keys(CUP_TABLE).map((k) => <option key={k}>{k}</option>)}
              </select>
            </label>
            <label style={{ ...toolLabel, color: C.inkSoft }}>Measure<br />
              <select value={cupMl} onChange={(e) => setCupMl(Number(e.target.value))} style={{ ...toolInput(), marginTop: 4 }}>
                {MEASURES.map(([label, ml]) => <option key={label} value={ml}>{label}</option>)}
              </select>
            </label>
          </div>
          <div style={resultBox()}>
            <strong>{Math.round(CUP_TABLE[cupItem] * (cupMl / 250))} g</strong> · {trimNum(cupMl)} ml — AU standard: 250 ml cup, 20 ml tablespoon, 5 ml teaspoon.
          </div>
        </>))}

        {T("Imperial → metric", (<>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ ...toolLabel, color: C.inkSoft, width: 90 }}>Amount<br />
              <input type="number" min="0" step="0.25" value={impQty} onChange={(e) => setImpQty(e.target.value)} style={{ ...toolInput(), marginTop: 4 }} />
            </label>
            <label style={{ ...toolLabel, color: C.inkSoft, flex: "1 1 180px" }}>Unit<br />
              <select value={impIdx} onChange={(e) => setImpIdx(Number(e.target.value))} style={{ ...toolInput(), marginTop: 4 }}>
                {IMPERIAL.map(([label], i) => <option key={label} value={i}>{label.replace("1 ", "")}</option>)}
              </select>
            </label>
          </div>
          <div style={resultBox()}>
            <strong>{trimNum(Math.round((Number(impQty) || 0) * IMPERIAL[impIdx][1] * 10) / 10)} {String(IMPERIAL[impIdx][2]).split(" ")[0]}</strong>
            {String(IMPERIAL[impIdx][2]).includes("—") ? ` ${String(IMPERIAL[impIdx][2]).slice(String(IMPERIAL[impIdx][2]).indexOf("—"))}` : ""}
            {" "}· °F to °C ≈ (°F − 32) ÷ 1.8, then − 20°C for fan-forced.
          </div>
        </>))}

        {T("Scaling calculator", (<>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ ...toolLabel, color: C.inkSoft, width: 110 }}>Recipe amount<br />
              <input type="number" min="0" value={scAmt} onChange={(e) => setScAmt(e.target.value)} style={{ ...toolInput(), marginTop: 4 }} />
            </label>
            <label style={{ ...toolLabel, color: C.inkSoft, width: 100 }}>Recipe serves<br />
              <input type="number" min="0.5" step="0.5" value={scFrom} onChange={(e) => setScFrom(e.target.value)} style={{ ...toolInput(), marginTop: 4 }} />
            </label>
            <label style={{ ...toolLabel, color: C.inkSoft, width: 100 }}>I need<br />
              <input type="number" min="0.5" step="0.5" value={scTo} onChange={(e) => setScTo(e.target.value)} style={{ ...toolInput(), marginTop: 4 }} />
            </label>
          </div>
          <div style={resultBox()}>
            <strong>{trimNum(Math.round(((Number(scAmt) || 0) * ((Number(scTo) || 1) / (Number(scFrom) || 1))) * 10) / 10)}</strong>
            {" "}(×{trimNum(Math.round(((Number(scTo) || 1) / (Number(scFrom) || 1)) * 100) / 100)}) — for paper recipes that don't live in the app. Spices and salt scale to about 1.5× when doubling.
          </div>
        </>))}

        {T("Roast calculator", (<>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ ...toolLabel, color: C.inkSoft, flex: "1 1 130px" }}>Meat<br />
              <select value={meat} onChange={(e) => { setMeat(e.target.value); setDoneness(Object.keys(ROASTS[e.target.value].options)[0]); }} style={{ ...toolInput(), marginTop: 4 }}>
                {Object.keys(ROASTS).map((m) => <option key={m}>{m}</option>)}
              </select>
            </label>
            {Object.keys(roast.options).length > 1 && (
              <label style={{ ...toolLabel, color: C.inkSoft, flex: "1 1 120px" }}>Doneness<br />
                <select value={doneness} onChange={(e) => setDoneness(e.target.value)} style={{ ...toolInput(), marginTop: 4 }}>
                  {Object.keys(roast.options).map((d) => <option key={d}>{d}</option>)}
                </select>
              </label>
            )}
            <label style={{ ...toolLabel, color: C.inkSoft, width: 100 }}>Weight (kg)<br />
              <input type="number" min="0.3" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} style={{ ...toolInput(), marginTop: 4 }} />
            </label>
          </div>
          <div style={resultBox()}>
            <strong>≈ {fmtDur(roastMins)}</strong> at {roast.temp}°C fan-forced · pull at <strong>{roastOpt[1]}°C</strong> internal · rest {roast.rest} minutes under foil.
            A meat thermometer beats the clock every time — carryover adds 3–5°C while resting.
          </div>
        </>))}

        {T("Meat doneness temperatures", <ChartRows rows={DONENESS} />)}

        {T("Sourdough hydration calculator", (<>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {[["Flour (g)", sdFlour, setSdFlour], ["Water (g)", sdWater, setSdWater], ["Starter (g)", sdStarter, setSdStarter], ["Starter hydration %", sdHyd, setSdHyd]].map(([label, val, set]) => (
              <label key={label} style={{ ...toolLabel, color: C.inkSoft, width: 110 }}>{label}<br />
                <input type="number" min="0" value={val} onChange={(e) => set(e.target.value)} style={{ ...toolInput(), marginTop: 4 }} />
              </label>
            ))}
          </div>
          <div style={resultBox()}>
            <strong>{hydration}% hydration</strong> · total flour {Math.round(totFlour)} g, total water {Math.round(totWater)} g,
            dough {Math.round((Number(sdFlour) || 0) + (Number(sdWater) || 0) + (Number(sdStarter) || 0))} g,
            starter {totFlour ? Math.round(((Number(sdStarter) || 0) / totFlour) * 100) : 0}% of flour.
            Counts the flour and water inside your starter — most home loaves sit between 65% and 78%.
          </div>
        </>))}

        {T("Egg size converter", (<>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ ...toolLabel, color: C.inkSoft, width: 110 }}>Recipe eggs<br />
              <input type="number" min="1" max="12" value={eggCount} onChange={(e) => setEggCount(e.target.value)} style={{ ...toolInput(), marginTop: 4 }} />
            </label>
            <label style={{ ...toolLabel, color: C.inkSoft, flex: "1 1 150px" }}>Your eggs are<br />
              <select value={eggSize} onChange={(e) => setEggSize(Number(e.target.value))} style={{ ...toolInput(), marginTop: 4 }}>
                <option value={50}>Small — 50 g</option>
                <option value={55}>Medium — 55 g</option>
                <option value={60}>Large — 60 g (AU recipe standard)</option>
                <option value={70}>Jumbo — 70 g</option>
              </select>
            </label>
          </div>
          <div style={resultBox()}>
            Use <strong>{toFraction(eggNeeded)} egg{eggNeeded > 1 ? "s" : ""}</strong> ({eggTotal} g total needed).
            AU recipes assume 60 g eggs — for baking, crack, whisk and weigh for part-eggs.
          </div>
        </>))}

        {T("Gelatine converter", <ChartRows rows={GELATINE_NOTES} />)}

        {T("Ingredient substitutions", <ChartRows rows={SUBSTITUTIONS} />)}

        {T("What's in season (AU)", (<>
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ ...toolInput(), marginBottom: 10 }}>
            {monthNames.map((m) => <option key={m}>{m}</option>)}
          </select>
          <ChartRows rows={[["Fruit", SEASONS[month].fruit], ["Vegetables", SEASONS[month].veg]]} />
          <div style={{ fontSize: 12, color: C.faint, marginTop: 8, lineHeight: 1.5 }}>Indicative for southern Australia — tropical regions run earlier.</div>
        </>))}

        {T("Leftover safety", <ChartRows rows={LEFTOVER_SAFETY} />)}

      </div>
    </div>
  );
}


/* ---------- cloud sync card (Settings) ---------- */

function CloudSyncCard({ user, status, onSignIn, onSignOut, onSyncNow }) {
  const [email, setEmail] = useState("");
  return (
    <section style={settingsCard()}>
      <h2 style={sectionHead()}>Sync across devices</h2>
      {!syncConfigured ? (
        <p style={settingsHint()}>
          Not configured yet. Add your Supabase URL and anon key to <code>src/syncConfig.js</code> and redeploy — the README has the full walkthrough.
        </p>
      ) : !user ? (
        <>
          <p style={settingsHint()}>
            Sign in with your email and your whole kitchen — recipes, planners, shopping list, pans and settings — syncs to every device you sign in on. No password: a sign-in link is emailed to you.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && email.includes("@")) { onSignIn(email.trim()); } }}
              placeholder="you@example.com"
              style={{ flex: "1 1 200px", padding: "10px 14px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, fontSize: 14 }}
            />
            <button
              onClick={() => email.includes("@") && onSignIn(email.trim())}
              style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "10px 20px", fontSize: 13.5, fontWeight: 600 }}
            >
              Send sign-in link
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={settingsHint()}>
            Signed in as <strong>{user.email}</strong>. Changes sync automatically a few seconds after you make them; opening the app pulls the latest cloud copy. Last writer wins if two devices edit at once.
          </p>
          {status && <p style={{ ...settingsHint(), fontWeight: 600, color: C.green }}>{status}</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={onSyncNow} style={{ background: C.green, color: C.onPrimary, border: "none", borderRadius: 999, padding: "9px 18px", fontSize: 13.5, fontWeight: 600 }}>
              Sync now
            </button>
            <button onClick={onSignOut} style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: "9px 18px", fontSize: 13.5, fontWeight: 500 }}>
              Sign out
            </button>
          </div>
        </>
      )}
    </section>
  );
}
