
package com.example.ecommerce

import java.math.BigDecimal
import java.util.UUID

data class Product(val id: UUID, val name: String, val price: BigDecimal, var stock: Int)
data class CartItem(val product: Product, var quantity: Int)

class ShoppingCart {
    private val items = mutableListOf<CartItem>()

    fun addItem(product: Product, quantity: Int) {
        require(quantity > 0) { "Quantity must be positive" }
        require(product.stock >= quantity) { "Not enough stock" }

        val existing = items.find { it.product.id == product.id }
        if (existing != null) {
            existing.quantity += quantity
        } else {
            items.add(CartItem(product, quantity))
        }
        product.stock -= quantity
    }

    fun removeItem(productId: UUID) {
        val item = items.find { it.product.id == productId }
        if (item != null) {
            item.product.stock += item.quantity
            items.remove(item)
        }
    }

    fun calculateTotal(): BigDecimal {
        return items.fold(BigDecimal.ZERO) { acc, item ->
            acc.add(item.product.price.multiply(BigDecimal(item.quantity)))
        }
    }

    fun checkout(): Boolean {
        if (items.isEmpty()) return false
        items.clear()
        return true
    }
}
