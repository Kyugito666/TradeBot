import re

with open("rust-brain/src/agents/physicist.rs", "r") as f:
    code = f.read()

# 1. Imports
code = code.replace("StandardNormal", "StudentT")

# 2. Lookback window
code = code.replace("c.len() < 30", "c.len() < 200")
code = code.replace("insufficient candles for GBM", "insufficient candles for GBM (need 200+)")

# 3. Monte Carlo loop
mc_old = """        let mut final_prices = vec![0.0_f64; self.simulations];
        for fp in final_prices.iter_mut() {
            let mut p = price;
            for _ in 0..self.horizon {
                let z: f64 = StandardNormal.sample(&mut rng);
                p *= (drift + diff * z).exp();
            }
            *fp = p;
        }"""

mc_new = """        let t_dist = StudentT::new(3.0).unwrap();
        let mut final_prices = vec![0.0_f64; self.simulations];
        for fp in final_prices.iter_mut() {
            let mut p = price;
            for _ in 0..self.horizon {
                let z: f64 = t_dist.sample(&mut rng);
                p *= (drift + diff * z).exp();
            }
            *fp = p;
        }"""

code = code.replace(mc_old, mc_new)

# 4. is_vol_crisis lookback
code = code.replace("c.len() < 22", "c.len() < 200")

with open("rust-brain/src/agents/physicist.rs", "w") as f:
    f.write(code)
